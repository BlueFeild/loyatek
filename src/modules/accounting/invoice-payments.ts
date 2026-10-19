import { prisma } from "../../config/db";

// دفعات فواتير العملاء + كشف حساب العميل. كل المبالغ بالدولار (زي باقي النظام)
// وبتتعرض بعملة الشركة في الواجهة

export const PAYMENT_METHODS = ["CASH", "BANK", "CARD", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// أقل من ده = الفاتورة اتدفعت كلها (فرق تقريب تحويل العملة)
export const PAID_TOLERANCE = 0.005;

interface InvoiceLike {
  status: string;
  total: unknown;
  dueDate?: Date | null;
  payments?: { amount: unknown }[];
}

// المدفوع والباقي. فاتورة PAID قديمة من غير دفعات مسجّلة = مدفوعة كلها
export function invoiceBalance(inv: InvoiceLike) {
  const total = Number(inv.total);
  const payments = inv.payments ?? [];
  const paid = inv.status === "PAID" && payments.length === 0 ? total : payments.reduce((s, p) => s + Number(p.amount), 0);
  const due = Math.max(0, total - paid);
  const paymentStatus = inv.status === "DRAFT" ? "DRAFT" : due <= PAID_TOLERANCE ? "PAID" : paid > PAID_TOLERANCE ? "PARTIAL" : "UNPAID";
  return { paidAmount: paid, balanceDue: due <= PAID_TOLERANCE ? 0 : due, paymentStatus };
}

export function invoiceView<T extends InvoiceLike>(inv: T, now: Date = new Date()) {
  const b = invoiceBalance(inv);
  const overdue = b.balanceDue > 0 && inv.status !== "DRAFT" && Boolean(inv.dueDate && inv.dueDate < new Date(now.toDateString()));
  return { ...inv, ...b, overdue };
}

// الخزنة للكاش، البنك للتحويل/الكارت
function cashAccountFor(method: string) {
  return method === "BANK" || method === "CARD"
    ? { code: "1010", name: "Bank", type: "ASSET" }
    : { code: "1000", name: "Cash", type: "ASSET" };
}

async function getOrCreateAccount(tx: any, tenantId: string, a: { code: string; name: string; type: string }) {
  const found = await tx.account.findFirst({ where: { tenantId, code: a.code } });
  return found ?? tx.account.create({ data: { tenantId, ...a } });
}

// اليوم بالتقويم (UTC) - "2026-10-19"
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export class PaymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface AddPaymentInput {
  // المبلغ بالدولار - أو full=true = الباقي كله بالظبط (من غير فروق تحويل)
  amount?: number;
  full?: boolean;
  paidAt?: Date;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
}

// تسجيل دفعة: قفل الفاتورة (FOR UPDATE) عشان دفعتين في نفس اللحظة مايعدّوش الإجمالي،
// قيد (مدين الخزنة/البنك، دائن العملاء 1100) على فرع الفاتورة، وتحديث الحالة
export async function addInvoicePayment(tenantId: string, invoiceId: string, input: AddPaymentInput) {
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { payments: true, customer: true } });
    if (!inv) throw new PaymentError("Invoice not found", 404);
    if (inv.status === "DRAFT") throw new PaymentError("Issue the invoice first, then record payments.");
    const { balanceDue } = invoiceBalance(inv);
    if (balanceDue <= 0) throw new PaymentError("This invoice is already fully paid.");
    const amount = input.full ? balanceDue : Number(input.amount ?? 0);
    if (!(amount > 0)) throw new PaymentError("Enter the amount paid.");
    if (amount > balanceDue + PAID_TOLERANCE) throw new PaymentError("The payment is more than what's left on the invoice.");

    const method = input.method ?? "CASH";
    const paidAt = input.paidAt ?? new Date();
    // الدفعة مايصحش تبقى قبل يوم إصدار الفاتورة (كشف الحساب هيطلع بالسالب)
    const issuedDay = dayKey(inv.issuedAt ?? inv.createdAt);
    if (dayKey(paidAt) < issuedDay) throw new PaymentError(`The payment date can't be before the invoice date (${issuedDay}).`);
    const [cash, ar] = await Promise.all([
      getOrCreateAccount(tx, tenantId, cashAccountFor(method)),
      getOrCreateAccount(tx, tenantId, { code: "1100", name: "Accounts Receivable", type: "ASSET" }),
    ]);
    const entry = await tx.journalEntry.create({
      data: {
        tenantId,
        branchId: inv.branchId,
        date: paidAt,
        description: `Payment for ${inv.invoiceNumber} — ${inv.customer.name}${input.reference ? ` (${input.reference})` : ""}`,
        lines: { create: [{ accountId: cash.id, debit: amount }, { accountId: ar.id, credit: amount }] },
      },
    });
    const payment = await tx.invoicePayment.create({
      data: { tenantId, invoiceId: inv.id, amount, paidAt, method, reference: input.reference || null, notes: input.notes || null, journalEntryId: entry.id },
    });
    const after = invoiceBalance({ ...inv, payments: [...inv.payments, payment] });
    await tx.invoice.update({ where: { id: inv.id }, data: { status: after.paymentStatus === "PAID" ? "PAID" : "ISSUED" } });
    return payment;
  });
}

// مسح دفعة (غلطة) - بيشيل قيدها ويرجّع الفاتورة "غير مدفوعة/جزئي"
export async function deleteInvoicePayment(tenantId: string, invoiceId: string, paymentId: string) {
  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT "id" FROM "invoices" WHERE "id" = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const payment = await tx.invoicePayment.findFirst({ where: { id: paymentId, invoiceId, tenantId } });
    if (!payment) throw new PaymentError("Payment not found", 404);
    if (payment.journalEntryId) await tx.journalEntry.deleteMany({ where: { id: payment.journalEntryId, tenantId } });
    await tx.invoicePayment.delete({ where: { id: payment.id } });
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { payments: true } });
    // الفاتورة كانت PAID: نحسب من الدفعات اللي فاضلة بس
    const after = invoiceBalance({ ...inv, status: "ISSUED" });
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: after.paymentStatus === "PAID" ? "PAID" : "ISSUED" } });
    return { ok: true };
  });
}

export interface StatementLine {
  date: Date;
  type: "INVOICE" | "PAYMENT";
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  invoiceId: string;
}

// كشف حساب عميل: رصيد أول المدة (قبل "من")، الفواتير (مدين) والدفعات (دائن) بالترتيب
// مع الرصيد المتراكم، ورصيد آخر المدة. المسودات مش بتدخل (لسه ماتصدرتش)
export async function customerStatement(tenantId: string, customerId: string, from?: Date | null, to?: Date | null) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId } });
  if (!customer) return null;
  const invoices = await prisma.invoice.findMany({
    where: { tenantId, customerId, status: { in: ["ISSUED", "PAID"] } },
    include: { payments: true },
  });
  const events: Omit<StatementLine, "balance">[] = [];
  for (const inv of invoices) {
    const total = Number(inv.total);
    events.push({ date: inv.issuedAt ?? inv.createdAt, type: "INVOICE", reference: inv.invoiceNumber, description: `Invoice ${inv.invoiceNumber}`, debit: total, credit: 0, invoiceId: inv.id });
    if (inv.status === "PAID" && inv.payments.length === 0) {
      // فاتورة اتعلّمت مدفوعة قبل نظام الدفعات
      events.push({ date: inv.issuedAt ?? inv.createdAt, type: "PAYMENT", reference: inv.invoiceNumber, description: `Payment — ${inv.invoiceNumber}`, debit: 0, credit: total, invoiceId: inv.id });
    }
    for (const p of inv.payments) {
      events.push({
        date: p.paidAt,
        type: "PAYMENT",
        reference: p.reference || inv.invoiceNumber,
        description: `Payment (${p.method.toLowerCase()}) — ${inv.invoiceNumber}`,
        debit: 0,
        credit: Number(p.amount),
        invoiceId: inv.id,
      });
    }
  }
  // باليوم الأول، وفي نفس اليوم الفاتورة قبل دفعاتها (الدفعة المسجّلة "النهارده" بتبقى
  // الساعة 12 بالليل، فبالوقت بس كانت بتطلع قبل الفاتورة والرصيد بالسالب)
  const typeOrder = (t: string) => (t === "INVOICE" ? 0 : 1);
  events.sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)) || typeOrder(a.type) - typeOrder(b.type) || a.date.getTime() - b.date.getTime());
  let opening = 0;
  const lines: StatementLine[] = [];
  let running = 0;
  for (const e of events) {
    if (from && e.date < from) {
      opening += e.debit - e.credit;
      continue;
    }
    if (to && e.date >= to) continue;
    if (lines.length === 0) running = opening;
    running += e.debit - e.credit;
    lines.push({ ...e, balance: running });
  }
  const totalInvoiced = lines.reduce((s, l) => s + l.debit, 0);
  const totalPaid = lines.reduce((s, l) => s + l.credit, 0);
  return {
    customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email },
    from: from ?? null,
    to: to ?? null,
    openingBalance: opening,
    lines,
    totalInvoiced,
    totalPaid,
    closingBalance: opening + totalInvoiced - totalPaid,
  };
}

// العملاء اللي عليهم فلوس (للقايمة جنب كشف الحساب)
export async function receivablesByCustomer(tenantId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId, status: "ISSUED" },
    include: { payments: true, customer: { select: { id: true, name: true } } },
  });
  const map = new Map<string, { customerId: string; name: string; balanceDue: number; invoices: number; overdue: number }>();
  for (const inv of invoices) {
    const v = invoiceView(inv);
    if (v.balanceDue <= 0) continue;
    const row = map.get(inv.customerId) ?? { customerId: inv.customerId, name: inv.customer.name, balanceDue: 0, invoices: 0, overdue: 0 };
    row.balanceDue += v.balanceDue;
    row.invoices += 1;
    if (v.overdue) row.overdue += v.balanceDue;
    map.set(inv.customerId, row);
  }
  return [...map.values()].sort((a, b) => b.balanceDue - a.balanceDue);
}
