import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const accountsRouter = Router();

accountsRouter.use(requireAuth);

accountsRouter.get("/", async (req, res) => {
  const accounts = await prisma.account.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { code: "asc" },
  });
  res.json(accounts);
});

const createAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(2),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
});

// إنشاء حساب في دليل الحسابات - مسموح لـ OWNER/ADMIN بس لأنه إعداد أساسي
// يأثر على كل القيود اللي جاية بعد كده
accountsRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const account = await prisma.account.create({
      data: { tenantId: req.auth!.tenantId, ...parsed.data },
    });
    res.status(201).json(account);
  } catch {
    res.status(400).json({ error: "Account code already exists for this company" });
  }
});

// إعداد سريع لدليل حسابات مبدئي (بدل ما العميل يضيف كل حساب يدوي)
accountsRouter.post("/seed-defaults", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const defaults: { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE" }[] = [
    { code: "1000", name: "Cash", type: "ASSET" },
    { code: "1200", name: "Inventory", type: "ASSET" },
    { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
    { code: "3000", name: "Owner's Equity", type: "EQUITY" },
    { code: "4000", name: "Sales Revenue", type: "REVENUE" },
    { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
  ];

  const created = await prisma.$transaction(
    defaults.map((acc) =>
      prisma.account.upsert({
        where: { tenantId_code: { tenantId: req.auth!.tenantId, code: acc.code } },
        update: {},
        create: { tenantId: req.auth!.tenantId, ...acc },
      })
    )
  );
  res.status(201).json(created);
});
