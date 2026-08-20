import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { advanceDeal, markDealLost } from "./deals.service";

export const dealsRouter = Router();

dealsRouter.use(requireAuth);

dealsRouter.get("/", async (req, res) => {
  const deals = await prisma.deal.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(deals);
});

const createDealSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(2),
  value: z.number().min(0),
});

dealsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createDealSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const [deal] = await prisma.$transaction([
    prisma.deal.create({ data: { tenantId: req.auth!.tenantId, ...parsed.data }, include: { customer: true } }),
    prisma.activity.create({
      data: {
        tenantId: req.auth!.tenantId,
        customerId: parsed.data.customerId,
        type: "STAGE_CHANGE",
        text: `New deal "${parsed.data.name}" created at LEAD stage`,
      },
    }),
  ]);
  res.status(201).json(deal);
});

// تحريك الصفقة للمرحلة الجاية في التسلسل (LEAD → QUALIFIED → PROPOSAL → WON)
dealsRouter.post("/:id/advance", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const deal = await advanceDeal(req.auth!.tenantId, req.params.id);
    res.json(deal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

dealsRouter.post("/:id/lost", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const deal = await markDealLost(req.auth!.tenantId, req.params.id);
    res.json(deal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
