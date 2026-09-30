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

// ميزان المراجعة (Trial Balance): إجمالي مدين ودائن لكل حساب، مبني
// على القيود الفعلية المسجلة - مش أرقام مجمّعة يدويًا
export async function getTrialBalance(tenantId: string) {
  const accounts = await prisma.account.findMany({
    where: { tenantId },
    include: {
      lines: true,
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
