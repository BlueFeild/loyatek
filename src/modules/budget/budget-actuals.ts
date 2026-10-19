import { prisma } from "../../config/db";

// "الفعلي" في الميزانية بيتحسب من بيانات حقيقية حسب نوع البند (قبل كده كان دايمًا
// = المبيعات، حتى لبند زي "Rent"):
//  - "sales"   : بند إيرادات (Sales / Revenue / Income / مبيعات / إيرادات) = صافي الإيرادات في
//                القيود (مبيعات المحل + فواتير العملاء + قيود يدوية) + المبيعات القديمة اللي مالهاش قيد
//  - "account" : اسم البند (أو كوده) = حساب في دليل الحسابات = صافي حركة الحساب ده في القيود
//  - "bills"   : غير كده = فواتير المصروفات اللي ليها نفس الفئة (Rent, Utilities, ...)
// الشهر بتوقيت UTC، والفرع = فرع البند + الحاجات المسجّلة على "الشركة كلها" (من غير فرع)
export type ActualSource = "sales" | "account" | "bills";

const REVENUE_WORDS = ["sales", "revenue", "revenues", "income", "مبيعات", "المبيعات", "ايراد", "إيراد", "ايرادات", "إيرادات", "الإيرادات", "الايرادات"];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function isRevenueCategory(category: string): boolean {
  const c = norm(category);
  return c.split(/[\s/&,-]+/).some((w) => REVENUE_WORDS.includes(w));
}

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  type: string;
}

// أي حساب (مصروف أو إيراد) اسمه أو كوده نفس اسم البند بالظبط (من غير حساسية لحالة الحروف)
export function matchAccount(category: string, accounts: AccountRef[]): AccountRef | null {
  const c = norm(category);
  return accounts.find((a) => (a.type === "EXPENSE" || a.type === "REVENUE") && (norm(a.name) === c || a.code === category.trim())) ?? null;
}

export function classifyBudgetCategory(category: string, accounts: AccountRef[]): { source: ActualSource; account: AccountRef | null } {
  // الإيرادات الأول: "Sales Revenue" لازم تشمل المبيعات كمان مش حساب 4000 بس
  if (isRevenueCategory(category)) return { source: "sales", account: null };
  const account = matchAccount(category, accounts);
  if (account) return { source: "account", account };
  return { source: "bills", account: null };
}

export function monthRange(month: number, year: number) {
  return { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) };
}

interface LineLike {
  tenantId: string;
  branchId: string;
  category: string;
  periodMonth: number;
  periodYear: number;
}

// صافي الحركة على حسابات معيّنة (إيراد = دائن - مدين، مصروف = مدين - دائن)
async function ledgerNet(tenantId: string, branchId: string, period: { gte: Date; lt: Date }, accountIds: string[], creditNormal: boolean) {
  if (accountIds.length === 0) return 0;
  const agg = await prisma.journalEntryLine.aggregate({
    where: {
      accountId: { in: accountIds },
      journalEntry: { tenantId, date: period, OR: [{ branchId }, { branchId: null }] },
    },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(agg._sum.debit ?? 0);
  const credit = Number(agg._sum.credit ?? 0);
  return creditNormal ? credit - debit : debit - credit;
}

export async function computeActual(line: LineLike, accounts: AccountRef[]): Promise<{ actual: number; source: ActualSource }> {
  const { tenantId, branchId } = line;
  const period = monthRange(line.periodMonth, line.periodYear);
  const { source, account } = classifyBudgetCategory(line.category, accounts);

  if (source === "account" && account) {
    const actual = await ledgerNet(tenantId, branchId, period, [account.id], account.type === "REVENUE");
    return { actual, source };
  }

  if (source === "sales") {
    // المبيعات الجديدة بقت بتعمل قيد (فهي جوه إيرادات القيود). المبيعات القديمة من غير
    // قيد بتتجمع لوحدها - كده مفيش بيع بيتحسب مرتين
    const sales = await prisma.sale.aggregate({
      where: { tenantId, branchId, createdAt: period, journalEntryId: null },
      _sum: { totalAmount: true },
    });
    const revenueIds = accounts.filter((a) => a.type === "REVENUE").map((a) => a.id);
    const ledger = await ledgerNet(tenantId, branchId, period, revenueIds, true);
    return { actual: Number(sales._sum.totalAmount ?? 0) + ledger, source };
  }

  const bills = await prisma.vendorBill.aggregate({
    where: {
      tenantId,
      category: { equals: line.category.trim(), mode: "insensitive" },
      issueDate: period,
      OR: [{ branchId }, { branchId: null }],
    },
    _sum: { amount: true },
  });
  return { actual: Number(bills._sum.amount ?? 0), source };
}
