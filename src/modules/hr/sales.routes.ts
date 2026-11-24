import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { recordSale, voidSale } from "./sales.service";

export const salesRouter = Router();

salesRouter.use(requireAuth, requireModule("erp"));

salesRouter.get("/", async (req, res) => {
  const sales = await prisma.sale.findMany({
    where: { tenantId: req.auth!.tenantId },
    // من الموظف الاسم والمنصب بس (مش المرتب) - تدقيق ERP-06
    include: { employee: { select: { id: true, name: true, position: true, branchId: true } }, item: true },
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
    const sale = await recordSale({ tenantId: req.auth!.tenantId, ...parsed.data, actor: { userId: req.auth!.userId, role: req.auth!.role } });
    res.status(201).json(sale);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// إلغاء بيع (المدير فما فوق): الكمية ترجع للمخزون والقيد يتشال (تدقيق DATA-004)
salesRouter.post("/:id/void", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const me = await prisma.user.findFirst({ where: { id: req.auth!.userId }, select: { name: true, email: true } });
  const done = await voidSale(req.auth!.tenantId, req.params.id, me?.name || me?.email || "a manager");
  if (!done) return res.status(404).json({ error: "Sale not found (maybe it was already cancelled)" });
  res.json({ ok: true, ...done });
});
