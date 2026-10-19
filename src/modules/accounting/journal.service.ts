import { prisma } from "../../config/db";

interface JournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
}

interface CreateJournalEntryInput {
  tenantId: string;
  description: string;
  date?: Date;
  branchId?: string | null;
  lines: JournalLineInput[];
}

// أهم قاعدة في المحاسبة كلها: مجموع المدين لازم يساوي مجموع الدائن.
// لو مش متساويين، القيد مرفوض من الأساس - مش مسموح يتسجل قيد "مش متوازن"
export async function createJournalEntry(input: CreateJournalEntryInput) {
  if (input.lines.length < 2) {
    throw new Error("A journal entry needs at least two lines (double-entry)");
  }

  const totalDebit = input.lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
  const totalCredit = input.lines.reduce((sum, l) => sum + (l.credit ?? 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new Error(
      `Journal entry is not balanced: total debit (${totalDebit}) must equal total credit (${totalCredit})`
    );
  }

  return prisma.journalEntry.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId ?? null,
      description: input.description,
      date: input.date ?? new Date(),
      lines: {
        create: input.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit ?? 0,
          credit: l.credit ?? 0,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
}

export interface LedgerFilter {
  // كل شهر لوحده (أو من/إلى) - فاضي = كل الفترات
  period?: { gte: Date; lt: Date } | null;
  // فرع واحد بس - فاضي = الشركة كلها
  branchId?: string | null;
}

// ميزان المراجعة (Trial Balance): إجمالي مدين ودائن لكل حساب، مبني
// على القيود الفعلية المسجلة - مش أرقام مجمّعة يدويًا. ممكن لشهر واحد أو لفرع واحد
export async function getTrialBalance(tenantId: string, filter: LedgerFilter = {}) {
  const entryWhere = { ...(filter.period ? { date: filter.period } : {}), ...(filter.branchId ? { branchId: filter.branchId } : {}) };
  const accounts = await prisma.account.findMany({
    where: { tenantId },
    include: {
      lines: Object.keys(entryWhere).length ? { where: { journalEntry: entryWhere } } : true,
    },
    orderBy: { code: "asc" },
  });

  return accounts.map((account: (typeof accounts)[number]) => {
    const totalDebit = account.lines.reduce((sum: number, l: { debit: unknown }) => sum + Number(l.debit), 0);
    const totalCredit = account.lines.reduce((sum: number, l: { credit: unknown }) => sum + Number(l.credit), 0);
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      totalDebit,
      totalCredit,
      balance: totalDebit - totalCredit,
    };
  });
}

// الأرباح والخسائر للفترة: الإيرادات - المصروفات (لشهر/فرع)
export async function getProfitAndLoss(tenantId: string, filter: LedgerFilter = {}) {
  const rows = await getTrialBalance(tenantId, filter);
  const revenue = rows.filter((r) => r.type === "REVENUE").map((r) => ({ code: r.code, name: r.name, amount: r.totalCredit - r.totalDebit }));
  const expenses = rows.filter((r) => r.type === "EXPENSE").map((r) => ({ code: r.code, name: r.name, amount: r.totalDebit - r.totalCredit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  return { revenue: revenue.filter((r) => Math.abs(r.amount) > 0.000001), expenses: expenses.filter((r) => Math.abs(r.amount) > 0.000001), totalRevenue, totalExpenses, net: totalRevenue - totalExpenses };
}

// الميزانية العمومية في تاريخ معيّن (لحد آخر اليوم ده): الأصول = الخصوم + حقوق الملكية.
// أرباح الفترة (الإيرادات - المصروفات لحد التاريخ ده) بتتحسب ضمن حقوق الملكية كـ
// "Retained earnings"، فالمعادلة بتقفل لوحدها لأن كل قيد متوازن. فرع واحد = قيوده بس
export async function getBalanceSheet(tenantId: string, opts: { asOf?: Date | null; branchId?: string | null } = {}) {
  const period = opts.asOf ? { gte: new Date(0), lt: opts.asOf } : null;
  const rows = await getTrialBalance(tenantId, { period, branchId: opts.branchId ?? null });
  const pick = (type: string, sign: 1 | -1) =>
    rows
      .filter((r) => r.type === type)
      .map((r) => ({ code: r.code, name: r.name, amount: sign * (r.totalDebit - r.totalCredit) }))
      .filter((r) => Math.abs(r.amount) > 0.000001);
  const assets = pick("ASSET", 1);
  const liabilities = pick("LIABILITY", -1);
  const equity = pick("EQUITY", -1);
  const revenue = rows.filter((r) => r.type === "REVENUE").reduce((s, r) => s + r.totalCredit - r.totalDebit, 0);
  const expenses = rows.filter((r) => r.type === "EXPENSE").reduce((s, r) => s + r.totalDebit - r.totalCredit, 0);
  const retainedEarnings = revenue - expenses;
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const totalEquity = sum(equity) + retainedEarnings;
  return {
    asOf: opts.asOf ? new Date(opts.asOf.getTime() - 1) : null,
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.005,
  };
}
