import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { createInvoice, issueInvoice, getVatReport } from "./invoices.service";
import { PAYMENT_METHODS, addInvoicePayment, deleteInvoicePayment, invoiceView, receivablesByCustomer } from "./invoice-payments";

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth, requireModule("erp"));

const paymentsOrder = { orderBy: { paidAt: "asc" as const } };

// كل فاتورة معاها المدفوع والباقي وحالة السداد (UNPAID / PARTIAL / PAID) ومتأخرة ولا لأ
invoicesRouter.get("/", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { items: true, customer: true, payments: paymentsOrder },
    orderBy: { createdAt: "desc" },
  });
  res.json(invoices.map((i: any) => invoiceView(i)));
});

// العملاء اللي عليهم فلوس (فواتير مصدّرة لسه مش مدفوعة كلها)
invoicesRouter.get("/receivables", async (req, res) => {
  res.json(await receivablesByCustomer(req.auth!.tenantId));
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a valid date");
const toDate = (s?: string | null) => (s ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s) : null);

const createInvoiceSchema = z.object({
  branchId: z.string().uuid(),
  customerId: z.string().uuid(),
  dueDate: dateStr.nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPrice: z.number().min(0),
      })
    )
    .min(1),
});

invoicesRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { dueDate, notes, ...rest } = parsed.data;
    const invoice = await createInvoice({ tenantId: req.auth!.tenantId, ...rest, dueDate: toDate(dueDate), notes: notes || null });
    res.status(201).json(invoice);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

// إصدار الفاتورة - بيحسب الضريبة، يولّد الـ QR، وينشئ القيد المحاسبي تلقائيًا
invoicesRouter.post("/:id/issue", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const invoice = await issueInvoice(req.auth!.tenantId, req.params.id);
    res.json(invoice);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const vatReportSchema = z.object({
  start: z.string(),
  end: z.string(),
});

// تقرير ضريبة بضغطة واحدة - إجمالي VAT محصّل من فواتير حقيقية في فترة معيّنة
invoicesRouter.get("/vat-report", async (req, res) => {
  const parsed = vatReportSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const report = await getVatReport(req.auth!.tenantId, new Date(parsed.data.start), new Date(parsed.data.end));
  res.json(report);
});

// فاتورة واحدة كاملة (للطباعة / PDF): البنود، العميل، الفرع، الدفعات، والشركة
invoicesRouter.get("/:id", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const inv = await prisma.invoice.findFirst({
    where: { id: req.params.id, tenantId },
    include: { items: true, customer: true, branch: { select: { name: true, location: true } }, payments: paymentsOrder },
  });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const company = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, vatNumber: true, displayCurrency: true } });
  res.json({ ...invoiceView(inv), company });
});

const paymentSchema = z.object({
  // بالدولار (الواجهة بتحوّل من عملة الشركة) - أو full: true = الباقي كله
  amount: z.number().positive().optional(),
  full: z.boolean().optional(),
  paidAt: dateStr.optional(),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(500).optional(),
});

// تسجيل دفعة من العميل (كاملة أو جزء) - بقيد محاسبي
invoicesRouter.post("/:id/payments", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payment" });
  const d = parsed.data;
  if (!d.full && !d.amount) return res.status(400).json({ error: "Enter the amount paid." });
  try {
    const payment = await addInvoicePayment(req.auth!.tenantId, req.params.id, { ...d, paidAt: toDate(d.paidAt) ?? undefined });
    res.status(201).json(payment);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

invoicesRouter.delete("/:id/payments/:paymentId", requireRole("OWNER", "ADMIN"), async (req, res) => {
  try {
    res.json(await deleteInvoicePayment(req.auth!.tenantId, req.params.id, req.params.paymentId));
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
