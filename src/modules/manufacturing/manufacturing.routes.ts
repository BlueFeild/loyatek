import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const manufacturingRouter = Router();
manufacturingRouter.use(requireAuth);

manufacturingRouter.get("/boms", async (req, res) => {
  const boms = await prisma.billOfMaterials.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { components: { include: { item: true } } },
    orderBy: { createdAt: "desc" },
  });

  // التكلفة الإجمالية بتتحسب فعليًا من costPrice الحقيقي لكل صنف في
  // المخزون × الكمية المستخدمة - مش رقم مدخل يدوي
  const withCost = boms.map((b: any) => ({
    ...b,
    totalCost: b.components.reduce((sum: number, c: any) => sum + Number(c.item.costPrice) * c.quantityUsed, 0),
  }));

  res.json(withCost);
});

const createBomSchema = z.object({
  productName: z.string().min(1),
  components: z.array(z.object({ itemId: z.string().uuid(), quantityUsed: z.number().int().positive() })).min(1),
});

manufacturingRouter.post("/boms", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createBomSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // التأكد إن كل الأصناف موجودة فعليًا في مخزون نفس الشركة قبل الإنشاء
  const items = await prisma.inventoryItem.findMany({
    where: { tenantId: req.auth!.tenantId, id: { in: parsed.data.components.map((c) => c.itemId) } },
  });
  if (items.length !== parsed.data.components.length) {
    return res.status(400).json({ error: "One or more inventory items were not found" });
  }

  const bom = await prisma.billOfMaterials.create({
    data: {
      tenantId: req.auth!.tenantId,
      productName: parsed.data.productName,
      components: { create: parsed.data.components },
    },
    include: { components: { include: { item: true } } },
  });
  res.status(201).json(bom);
});

manufacturingRouter.delete("/boms/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const bom = await prisma.billOfMaterials.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!bom) return res.status(404).json({ error: "BOM not found" });

  await prisma.billOfMaterials.delete({ where: { id: bom.id } });
  res.json({ ok: true });
});
