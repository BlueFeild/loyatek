import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const rfqRouter = Router();

rfqRouter.use(requireAuth);

rfqRouter.get("/", async (req, res) => {
  const rfqs = await prisma.rfqRequest.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { item: true, quotes: { include: { supplier: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(rfqs);
});

const createRfqSchema = z.object({
  branchId: z.string().uuid(),
  itemId: z.string().uuid(),
  quotes: z
    .array(
      z.object({
        supplierId: z.string().uuid(),
        price: z.number().min(0),
        leadTimeDays: z.number().int().min(0),
        rating: z.number().min(0).max(5),
      })
    )
    .min(1),
});

// إنشاء طلب عروض أسعار جديد مع عروض المورّدين المرتبطة بيه دفعة واحدة
rfqRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createRfqSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rfq = await prisma.rfqRequest.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: parsed.data.branchId,
      itemId: parsed.data.itemId,
      quotes: { create: parsed.data.quotes },
    },
    include: { item: true, quotes: { include: { supplier: true } } },
  });
  res.status(201).json(rfq);
});

// اختيار عرض معيّن كـ "المورد الفايز" - بيلغي اختيار أي عرض تاني في نفس الطلب تلقائيًا
rfqRouter.post("/:id/quotes/:quoteId/select", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const rfq = await prisma.rfqRequest.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });

  await prisma.$transaction([
    prisma.rfqQuote.updateMany({ where: { rfqRequestId: rfq.id }, data: { selected: false } }),
    prisma.rfqQuote.update({ where: { id: req.params.quoteId }, data: { selected: true } }),
  ]);

  const updated = await prisma.rfqRequest.findFirst({
    where: { id: rfq.id },
    include: { item: true, quotes: { include: { supplier: true } } },
  });
  res.json(updated);
});
