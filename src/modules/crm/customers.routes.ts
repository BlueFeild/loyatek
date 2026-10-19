import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { customerStatement } from "../accounting/invoice-payments";

export const customersRouter = Router();

customersRouter.use(requireAuth, requireModule("erp"));

customersRouter.get("/", async (req, res) => {
  const customers = await prisma.customer.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(customers);
});

const createCustomerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
});

customersRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await prisma.customer.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(customer);
});

// سجل شراء العميل - مبني فعليًا من عمليات البيع (Sale) المرتبطة بيه،
// مش قائمة مجمّعة يدويًا. بيوضح كمان إجمالي إنفاقه الحقيقي عند الشركة
customersRouter.get("/:id/purchase-history", async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const sales = await prisma.sale.findMany({
    where: { customerId: customer.id },
    include: { item: true, employee: true },
    orderBy: { createdAt: "desc" },
  });

  const totalSpent = sales.reduce(
    (sum: number, s: { totalAmount: unknown }) => sum + Number(s.totalAmount),
    0
  );

  res.json({ customer, totalSpent, orderCount: sales.length, sales });
});

// Timeline موحّد للعميل - نشاطات حقيقية متسجلة (تحركات صفقات + ملاحظات يدوية)
customersRouter.get("/:id/timeline", async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const activities = await prisma.activity.findMany({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(activities);
});

const createActivitySchema = z.object({
  type: z.enum(["NOTE", "CALL", "EMAIL"]),
  text: z.string().min(1),
});

// إضافة نشاط يدوي (ملاحظة/مكالمة/إيميل) للعميل - بيظهر فورًا في الـ Timeline
customersRouter.post("/:id/activities", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = createActivitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const activity = await prisma.activity.create({
    data: { tenantId: req.auth!.tenantId, customerId: customer.id, ...parsed.data },
  });
  res.status(201).json(activity);
});

// كشف حساب العميل: ?from=YYYY-MM-DD&to=YYYY-MM-DD (الاتنين اختياري، "إلى" بيشمل اليوم نفسه)
customersRouter.get("/:id/statement", async (req, res) => {
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
  const from = day(req.query.from);
  const toDay = day(req.query.to);
  const to = toDay ? new Date(toDay.getTime() + 86400000) : null;
  const st = await customerStatement(req.auth!.tenantId, req.params.id, from, to);
  if (!st) return res.status(404).json({ error: "Customer not found" });
  const company = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { name: true, vatNumber: true } });
  res.json({ ...st, to: toDay, company });
});
