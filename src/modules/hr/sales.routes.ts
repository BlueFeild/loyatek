import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { recordSale } from "./sales.service";

export const salesRouter = Router();

salesRouter.use(requireAuth);

salesRouter.get("/", async (req, res) => {
  const sales = await prisma.sale.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { employee: true, item: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(sales);
});

const createSaleSchema = z.object({
  branchId: z.string().uuid(),
  employeeId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number().int().positive(),
  customerId: z.string().uuid().optional(),
});

// تسجيل بيع - مسموح لأي موظف تشغيلي (STAFF فما فوق) لأنها عملية يومية
salesRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = createSaleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const sale = await recordSale({ tenantId: req.auth!.tenantId, ...parsed.data });
    res.status(201).json(sale);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
