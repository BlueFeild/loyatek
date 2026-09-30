import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { createJournalEntry } from "./journal.service";

export const vendorBillsRouter = Router();
vendorBillsRouter.use(requireAuth);

// بيدوّر على حساب "مصروفات عامة" و"ذمم دائنة" في دليل حسابات الشركة،
// ولو مش موجودين بيعملهم تلقائيًا - عشان كل فاتورة مصروف تقدر تتسجّل
// كقيد محاسبي حقيقي من غير ما تجبري التاجر يظبط دليل الحسابات يدويًا الأول
async function getOrCreateDefaultAccounts(tenantId: string) {
  let expenseAccount = await prisma.account.findFirst({ where: { tenantId, code: "5000" } });
  if (!expenseAccount) {
    expenseAccount = await prisma.account.create({
      data: { tenantId, code: "5000", name: "General Expenses", type: "EXPENSE" },
    });
  }

  let payableAccount = await prisma.account.findFirst({ where: { tenantId, code: "2000" } });
  if (!payableAccount) {
    payableAccount = await prisma.account.create({
      data: { tenantId, code: "2000", name: "Accounts Payable", type: "LIABILITY" },
    });
  }

  return { expenseAccount, payableAccount };
}

vendorBillsRouter.get("/", async (req, res) => {
  const bills = await prisma.vendorBill.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { issueDate: "desc" },
  });
  res.json(bills);
});

const createBillSchema = z.object({
  vendorName: z.string().min(1),
  billNumber: z.string().optional(),
  category: z.string().optional(),
  amount: z.number().min(0.01),
  issueDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
});

// إنشاء فاتورة مصروف حقيقية - بتسجّل قيد محاسبي مزدوج فورًا (مدين:
// حساب المصروف، دائن: الذمم الدائنة) عشان الفاتورة تظهر فعليًا في
// ميزان المراجعة، مش رقم منفصل عن المحاسبة
vendorBillsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { expenseAccount, payableAccount } = await getOrCreateDefaultAccounts(req.auth!.tenantId);

  const entry = await createJournalEntry({
    tenantId: req.auth!.tenantId,
    description: `Vendor bill — ${parsed.data.vendorName}${parsed.data.billNumber ? ` (${parsed.data.billNumber})` : ""}`,
    date: parsed.data.issueDate ? new Date(parsed.data.issueDate) : undefined,
    lines: [
      { accountId: expenseAccount.id, debit: parsed.data.amount },
      { accountId: payableAccount.id, credit: parsed.data.amount },
    ],
  });

  const bill = await prisma.vendorBill.create({
    data: {
      tenantId: req.auth!.tenantId,
      vendorName: parsed.data.vendorName,
      billNumber: parsed.data.billNumber,
      category: parsed.data.category ?? "General",
      amount: parsed.data.amount,
      issueDate: parsed.data.issueDate ? new Date(parsed.data.issueDate) : undefined,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
      journalEntryId: entry.id,
    },
  });
  res.status(201).json(bill);
});

const updateBillSchema = z.object({
  status: z.enum(["UNPAID", "PAID", "OVERDUE"]).optional(),
});

vendorBillsRouter.patch("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const bill = await prisma.vendorBill.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!bill) return res.status(404).json({ error: "Bill not found" });

  const updated = await prisma.vendorBill.update({ where: { id: bill.id }, data: parsed.data });
  res.json(updated);
});

vendorBillsRouter.delete("/:id", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const bill = await prisma.vendorBill.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!bill) return res.status(404).json({ error: "Bill not found" });

  await prisma.vendorBill.delete({ where: { id: bill.id } });
  res.json({ ok: true });
});
