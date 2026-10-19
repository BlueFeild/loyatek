import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { assertTenantOwns } from "../../utils/tenant-owned";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { createJournalEntry, getBalanceSheet, getProfitAndLoss, getTrialBalance, type LedgerFilter } from "./journal.service";
import { periodFilter } from "../../utils/period";

// ?month=2026-10 و/أو ?branchId= (فلاتر القيود والتقارير)
function ledgerFilter(query: Record<string, unknown>): LedgerFilter {
  return { period: periodFilter(query), branchId: typeof query.branchId === "string" && query.branchId ? query.branchId : null };
}

export const journalRouter = Router();

journalRouter.use(requireAuth, requireModule("erp"));

journalRouter.get("/", async (req, res) => {
  const f = ledgerFilter(req.query as Record<string, unknown>);
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: req.auth!.tenantId, ...(f.period ? { date: f.period } : {}), ...(f.branchId ? { branchId: f.branchId } : {}) },
    include: { lines: { include: { account: true } }, branch: { select: { name: true } } },
    orderBy: { date: "desc" },
  });
  res.json(entries);
});

const createEntrySchema = z.object({
  description: z.string().min(2),
  date: z.string().datetime().optional(),
  branchId: z.string().uuid().nullable().optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.number().min(0).optional(),
        credit: z.number().min(0).optional(),
      })
    )
    .min(2),
});

// إنشاء قيد يومية - محاسب أو مدير بس، مش موظف تشغيلي عادي
journalRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // الفرع لازم يكون تبع نفس الشركة
  if (parsed.data.branchId && !(await prisma.branch.findFirst({ where: { id: parsed.data.branchId, tenantId: req.auth!.tenantId } }))) {
    return res.status(400).json({ error: "Branch not found" });
  }
  // كل حساب في القيد لازم يكون من دليل حسابات نفس الشركة
  try {
    await assertTenantOwns(req.auth!.tenantId, { accountIds: parsed.data.lines.map((l) => l.accountId) });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const entry = await createJournalEntry({
      tenantId: req.auth!.tenantId,
      description: parsed.data.description,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
      branchId: parsed.data.branchId ?? null,
      lines: parsed.data.lines,
    });
    res.status(201).json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ميزان المراجعة: صورة حقيقية لكل حساب مبنية على القيود المسجلة فعليًا
journalRouter.get("/trial-balance", async (req, res) => {
  const balance = await getTrialBalance(req.auth!.tenantId, ledgerFilter(req.query as Record<string, unknown>));
  res.json(balance);
});

// الأرباح والخسائر (شهر/فرع)
journalRouter.get("/profit-loss", async (req, res) => {
  res.json(await getProfitAndLoss(req.auth!.tenantId, ledgerFilter(req.query as Record<string, unknown>)));
});

// الميزانية العمومية: ?asOf=YYYY-MM-DD (لحد آخر اليوم ده، فاضي = لحد دلوقتي) و ?branchId=
journalRouter.get("/balance-sheet", async (req, res) => {
  const asOfStr = typeof req.query.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : null;
  const asOf = asOfStr ? new Date(new Date(`${asOfStr}T00:00:00Z`).getTime() + 86400000) : null;
  const branchId = typeof req.query.branchId === "string" && req.query.branchId ? req.query.branchId : null;
  res.json(await getBalanceSheet(req.auth!.tenantId, { asOf, branchId }));
});
