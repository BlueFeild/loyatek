import express, { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { periodFilter } from "../../utils/period";

export const vendorBillsRouter = Router();
vendorBillsRouter.use(requireAuth, requireModule("erp"));

// بيدوّر على الحسابات الأساسية في دليل حسابات الشركة، ولو مش موجودة بيعملها
// تلقائيًا - عشان كل فاتورة مصروف وكل سداد يتسجّلوا كقيود محاسبية حقيقية من غير
// ما التاجر يظبط دليل الحسابات يدويًا الأول
async function getOrCreateAccount(tx: any, tenantId: string, code: string, name: string, type: string) {
  const found = await tx.account.findFirst({ where: { tenantId, code } });
  if (found) return found;
  return tx.account.create({ data: { tenantId, code, name, type } });
}
// 5000 = تكلفة البضاعة المباعة (دليل الحسابات المبدئي) - فواتير المصروفات ليها حساب لوحدها 5100
// (قبل كده كانت بتتسجل على 5000 باسم "General Expenses" فبتختلط بتكلفة البضاعة)
export const BILL_EXPENSE_CODE = "5100";
const expenseAccount = (tx: any, t: string) => getOrCreateAccount(tx, t, BILL_EXPENSE_CODE, "General Expenses", "EXPENSE");
const payableAccount = (tx: any, t: string) => getOrCreateAccount(tx, t, "2000", "Accounts Payable", "LIABILITY");
const cashAccount = (tx: any, t: string) => getOrCreateAccount(tx, t, "1000", "Cash", "ASSET");

// الفرع لازم يكون تبع نفس الشركة
async function ownBranchId(tenantId: string, branchId: string | null | undefined) {
  if (!branchId) return null;
  const b = await prisma.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
  if (!b) throw Object.assign(new Error("Branch not found"), { status: 400 });
  return b.id;
}

const isOverdue = (b: { status: string; dueDate: Date | null }) => b.status !== "PAID" && Boolean(b.dueDate && b.dueDate < new Date(new Date().toDateString()));

function view(b: any) {
  return {
    ...b,
    // متأخرة = مش مدفوعة وعدّى ميعادها (بتتحسب كل مرة، مش حالة متخزنة)
    status: b.status === "PAID" ? "PAID" : isOverdue(b) ? "OVERDUE" : "UNPAID",
    attachment: b.attachment ? { fileName: b.attachment.fileName, mimeType: b.attachment.mimeType, size: b.attachment.size } : null,
    branchName: b.branch?.name ?? null,
  };
}
const withAttachMeta = { attachment: { select: { fileName: true, mimeType: true, size: true } }, branch: { select: { name: true } } };

// ?month=2026-10 (كل شهر لوحده) و/أو ?branchId= - ومعاها إجماليات الفترة
vendorBillsRouter.get("/", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const period = periodFilter(req.query as Record<string, unknown>);
  const branchId = typeof req.query.branchId === "string" && req.query.branchId ? req.query.branchId : null;
  const bills = await prisma.vendorBill.findMany({
    where: { tenantId, ...(period ? { issueDate: period } : {}), ...(branchId ? { branchId } : {}) },
    include: withAttachMeta,
    orderBy: { issueDate: "desc" },
  });
  const rows = bills.map(view);
  const sum = (f: (b: any) => boolean) => rows.filter(f).reduce((s: number, b: any) => s + Number(b.amount), 0);
  res.json({
    bills: rows,
    totals: {
      count: rows.length,
      total: sum(() => true),
      paid: sum((b) => b.status === "PAID"),
      unpaid: sum((b) => b.status !== "PAID"),
      overdue: sum((b) => b.status === "OVERDUE"),
    },
  });
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a valid date");
const createBillSchema = z.object({
  vendorName: z.string().trim().min(1, "Write the vendor name"),
  billNumber: z.string().trim().max(60).optional(),
  category: z.string().trim().max(60).optional(),
  amount: z.number().min(0.01, "The amount must be more than 0"),
  issueDate: dateStr.optional(),
  dueDate: dateStr.nullable().optional(),
  branchId: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).optional(),
  // مدفوعة من أول ما اتسجلت (كاش مثلًا)
  paid: z.boolean().optional(),
});

const toDate = (s?: string | null) => (s ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s) : undefined);

// قيد الفاتورة: مدين المصروفات / دائن الموردين
async function postBillEntry(tx: any, tenantId: string, bill: { vendorName: string; billNumber?: string | null; amount: number; issueDate: Date; branchId: string | null }) {
  const [exp, ap] = await Promise.all([expenseAccount(tx, tenantId), payableAccount(tx, tenantId)]);
  return tx.journalEntry.create({
    data: {
      tenantId,
      branchId: bill.branchId,
      date: bill.issueDate,
      description: `Vendor bill — ${bill.vendorName}${bill.billNumber ? ` (${bill.billNumber})` : ""}`,
      lines: { create: [{ accountId: exp.id, debit: bill.amount }, { accountId: ap.id, credit: bill.amount }] },
    },
  });
}

// قيد السداد: مدين الموردين / دائن الخزنة
async function postPaymentEntry(tx: any, tenantId: string, bill: { vendorName: string; amount: number; paidAt: Date; branchId: string | null }) {
  const [ap, cash] = await Promise.all([payableAccount(tx, tenantId), cashAccount(tx, tenantId)]);
  return tx.journalEntry.create({
    data: {
      tenantId,
      branchId: bill.branchId,
      date: bill.paidAt,
      description: `Bill payment — ${bill.vendorName}`,
      lines: { create: [{ accountId: ap.id, debit: bill.amount }, { accountId: cash.id, credit: bill.amount }] },
    },
  });
}

async function deleteEntry(tx: any, tenantId: string, id: string | null | undefined) {
  if (id) await tx.journalEntry.deleteMany({ where: { id, tenantId } });
}

// إنشاء فاتورة مصروف حقيقية - بتسجّل قيد محاسبي مزدوج فورًا (مدين: حساب المصروف،
// دائن: الموردين)، ولو مدفوعة من الأول كمان قيد السداد (مدين الموردين، دائن الخزنة)
vendorBillsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid bill" });
  const d = parsed.data;
  const tenantId = req.auth!.tenantId;
  let branchId: string | null;
  try {
    branchId = await ownBranchId(tenantId, d.branchId);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  const issueDate = toDate(d.issueDate) ?? new Date();
  const bill = await prisma.$transaction(async (tx: any) => {
    const entry = await postBillEntry(tx, tenantId, { vendorName: d.vendorName, billNumber: d.billNumber, amount: d.amount, issueDate, branchId });
    const paidAt = d.paid ? issueDate : null;
    const pay = paidAt ? await postPaymentEntry(tx, tenantId, { vendorName: d.vendorName, amount: d.amount, paidAt, branchId }) : null;
    return tx.vendorBill.create({
      data: {
        tenantId,
        vendorName: d.vendorName,
        billNumber: d.billNumber || null,
        category: d.category || "General",
        amount: d.amount,
        issueDate,
        dueDate: toDate(d.dueDate) ?? null,
        branchId,
        notes: d.notes || null,
        status: paidAt ? "PAID" : "UNPAID",
        paidAt,
        journalEntryId: entry.id,
        paymentJournalEntryId: pay?.id ?? null,
      },
      include: withAttachMeta,
    });
  });
  res.status(201).json(view(bill));
});

const updateBillSchema = z.object({
  vendorName: z.string().trim().min(1).optional(),
  billNumber: z.string().trim().max(60).nullable().optional(),
  category: z.string().trim().max(60).optional(),
  amount: z.number().min(0.01, "The amount must be more than 0").optional(),
  issueDate: dateStr.optional(),
  dueDate: dateStr.nullable().optional(),
  branchId: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  // مدفوعة / مش مدفوعة في الاتجاهين (لو حصلت لخبطة)
  status: z.enum(["PAID", "UNPAID"]).optional(),
  paidAt: dateStr.optional(),
});

// تعديل الفاتورة من غير ما نبدأ من الأول: أي تغيير في المبلغ/التاريخ/الفرع
// بيعيد كتابة القيد نفسه، والسداد بيتسجل أو يتشال بقيده
vendorBillsRouter.patch("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid change" });
  const tenantId = req.auth!.tenantId;
  const bill = await prisma.vendorBill.findFirst({ where: { id: req.params.id, tenantId } });
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  const d = parsed.data;
  let branchId = bill.branchId;
  try {
    if (d.branchId !== undefined) branchId = await ownBranchId(tenantId, d.branchId);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  const next = {
    vendorName: d.vendorName ?? bill.vendorName,
    billNumber: d.billNumber !== undefined ? d.billNumber || null : bill.billNumber,
    amount: d.amount ?? Number(bill.amount),
    issueDate: toDate(d.issueDate) ?? bill.issueDate,
    branchId,
  };
  const wantPaid = d.status ? d.status === "PAID" : bill.status === "PAID";
  const paidAt = wantPaid ? toDate(d.paidAt) ?? (bill.status === "PAID" && bill.paidAt ? bill.paidAt : new Date()) : null;

  const updated = await prisma.$transaction(async (tx: any) => {
    // قيد الفاتورة بيتعاد بالأرقام الجديدة (أبسط وأضمن من تعديل السطور)
    const billChanged = next.amount !== Number(bill.amount) || next.issueDate.getTime() !== bill.issueDate.getTime() || next.branchId !== bill.branchId || next.vendorName !== bill.vendorName || next.billNumber !== bill.billNumber;
    let journalEntryId = bill.journalEntryId;
    if (billChanged || !journalEntryId) {
      await deleteEntry(tx, tenantId, journalEntryId);
      journalEntryId = (await postBillEntry(tx, tenantId, next)).id;
    }
    let paymentJournalEntryId = bill.paymentJournalEntryId;
    const paymentChanged = !wantPaid || billChanged || !paymentJournalEntryId || (paidAt && bill.paidAt && paidAt.getTime() !== bill.paidAt.getTime());
    if (paymentChanged) {
      await deleteEntry(tx, tenantId, paymentJournalEntryId);
      paymentJournalEntryId = wantPaid && paidAt ? (await postPaymentEntry(tx, tenantId, { vendorName: next.vendorName, amount: next.amount, paidAt, branchId })).id : null;
    }
    return tx.vendorBill.update({
      where: { id: bill.id },
      data: {
        vendorName: next.vendorName,
        billNumber: next.billNumber,
        category: d.category ?? bill.category,
        amount: next.amount,
        issueDate: next.issueDate,
        dueDate: d.dueDate !== undefined ? toDate(d.dueDate) ?? null : bill.dueDate,
        branchId,
        notes: d.notes !== undefined ? d.notes || null : bill.notes,
        status: wantPaid ? "PAID" : "UNPAID",
        paidAt,
        journalEntryId,
        paymentJournalEntryId,
      },
      include: withAttachMeta,
    });
  });
  res.json(view(updated));
});

// المسح بيشيل القيود كمان (قبل كده القيد كان بيفضل في ميزان المراجعة)
vendorBillsRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const bill = await prisma.vendorBill.findFirst({ where: { id: req.params.id, tenantId } });
  if (!bill) return res.status(404).json({ error: "Bill not found" });
  await prisma.$transaction(async (tx: any) => {
    await deleteEntry(tx, tenantId, bill.journalEntryId);
    await deleteEntry(tx, tenantId, bill.paymentJournalEntryId);
    await tx.vendorBill.delete({ where: { id: bill.id } });
  });
  res.json({ ok: true });
});

// --- صورة/PDF الفاتورة الأصلية ---
const ATTACH_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_ATTACH_MB = 10;

// رفع خام (application/octet-stream)، الاسم والنوع في الـ query - بيستبدل القديم لو موجود
vendorBillsRouter.post(
  "/:id/attachment",
  requireRole("OWNER", "ADMIN", "MANAGER"),
  express.raw({ type: "application/octet-stream", limit: `${MAX_ATTACH_MB + 1}mb` }),
  async (req, res) => {
    const tenantId = req.auth!.tenantId;
    const bill = await prisma.vendorBill.findFirst({ where: { id: req.params.id, tenantId } });
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    const mimeType = String(req.query.mimeType ?? "");
    const fileName = String(req.query.fileName ?? "invoice").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
    if (!ATTACH_TYPES[mimeType]) return res.status(400).json({ error: "Upload a PDF or a photo (PNG, JPG, WebP)" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "The file is empty" });
    if (req.body.length > MAX_ATTACH_MB * 1024 * 1024) return res.status(413).json({ error: `The file is too large (max ${MAX_ATTACH_MB} MB)` });
    await prisma.vendorBillAttachment.upsert({
      where: { billId: bill.id },
      create: { billId: bill.id, tenantId, fileName, mimeType, size: req.body.length, data: req.body },
      update: { fileName, mimeType, size: req.body.length, data: req.body },
    });
    const full = await prisma.vendorBill.findUnique({ where: { id: bill.id }, include: withAttachMeta });
    res.json(view(full));
  }
);

vendorBillsRouter.get("/:id/attachment", async (req, res) => {
  const a = await prisma.vendorBillAttachment.findFirst({ where: { billId: req.params.id, tenantId: req.auth!.tenantId } });
  if (!a) return res.status(404).json({ error: "No file on this bill" });
  res.setHeader("Content-Type", a.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${a.fileName}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(a.data));
});

vendorBillsRouter.delete("/:id/attachment", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  await prisma.vendorBillAttachment.deleteMany({ where: { billId: req.params.id, tenantId: req.auth!.tenantId } });
  res.json({ ok: true });
});
