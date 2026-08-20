import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  receivePurchaseOrder,
  markPurchaseOrderPaid,
} from "./purchase-orders.service";

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.use(requireAuth);

purchaseOrdersRouter.get("/", async (req, res) => {
  const orders = await prisma.purchaseOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { items: true, supplier: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

const createPOSchema = z.object({
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().positive(),
        unitCost: z.number().min(0),
      })
    )
    .min(1),
});

purchaseOrdersRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createPOSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const po = await createPurchaseOrder({ tenantId: req.auth!.tenantId, ...parsed.data });
    res.status(201).json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// تحويل الأمر من DRAFT لـ ORDERED (اتبعت للمورد فعليًا) أو CANCELLED
purchaseOrdersRouter.post("/:id/status", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const schema = z.object({ status: z.enum(["ORDERED", "CANCELLED"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const po = await updatePurchaseOrderStatus(req.auth!.tenantId, req.params.id, parsed.data.status);
    res.json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// أهم مسار: تسلّم الأمر فعليًا - ده اللي بيحدّث المخزون تلقائيًا
purchaseOrdersRouter.post("/:id/receive", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const po = await receivePurchaseOrder(req.auth!.tenantId, req.params.id);
    res.json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// جدولة المستحقات (Accounts Payable) - أوامر الشراء المُستلمة اللي عندها
// مبلغ مستحق فعليًا، محسوب من بنود الأمر الحقيقية مش رقم منفصل
purchaseOrdersRouter.get("/accounts-payable", async (req, res) => {
  const orders = await prisma.purchaseOrder.findMany({
    where: { tenantId: req.auth!.tenantId, status: "RECEIVED" },
    include: { items: true, supplier: true },
    orderBy: { dueDate: "asc" },
  });

  const payable = orders.map((po: { items: { quantity: number; unitCost: unknown }[]; dueDate: Date | null }) => {
    const amountDue = po.items.reduce(
      (sum: number, i: { quantity: number; unitCost: unknown }) => sum + i.quantity * Number(i.unitCost),
      0
    );
    const isOverdue = po.dueDate ? new Date(po.dueDate) < new Date() : false;
    return { ...po, amountDue, isOverdue };
  });

  res.json(payable);
});

purchaseOrdersRouter.post("/:id/mark-paid", requireRole("OWNER", "ADMIN"), async (req, res) => {
  try {
    const po = await markPurchaseOrderPaid(req.auth!.tenantId, req.params.id);
    res.json(po);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
