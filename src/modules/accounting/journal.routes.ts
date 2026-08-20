import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { createJournalEntry, getTrialBalance } from "./journal.service";

export const journalRouter = Router();

journalRouter.use(requireAuth);

journalRouter.get("/", async (req, res) => {
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { lines: { include: { account: true } } },
    orderBy: { date: "desc" },
  });
  res.json(entries);
});

const createEntrySchema = z.object({
  description: z.string().min(2),
  date: z.string().datetime().optional(),
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

  try {
    const entry = await createJournalEntry({
      tenantId: req.auth!.tenantId,
      description: parsed.data.description,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
      lines: parsed.data.lines,
    });
    res.status(201).json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ميزان المراجعة: صورة حقيقية لكل حساب مبنية على القيود المسجلة فعليًا
journalRouter.get("/trial-balance", async (req, res) => {
  const balance = await getTrialBalance(req.auth!.tenantId);
  res.json(balance);
});
