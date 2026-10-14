import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { CURRENCY_CODES, clearRatesCache, getRates, getRatesTable, refreshRatesFromInternet } from "../../utils/money";

// أسعار الصرف: عامة (صفحات المنصة والأسعار بتحوّل بيها من الدولار)، وإدارتها
// للسوبر أدمن بس (يشوف التلقائي، يثبّت سعر بإيده، أو يحدّث من الإنترنت فورًا)
export const publicExchangeRatesRouter = Router();

publicExchangeRatesRouter.get("/", async (_req, res) => {
  res.json({ base: "USD", rates: await getRates() });
});

export const adminExchangeRatesRouter = Router();
adminExchangeRatesRouter.use(requireAuth, requireSuperAdmin);

adminExchangeRatesRouter.get("/", async (_req, res) => {
  res.json(await getRatesTable());
});

adminExchangeRatesRouter.post("/refresh", async (_req, res) => {
  const result = await refreshRatesFromInternet();
  if (!result.ok) return res.status(502).json({ error: `Couldn't refresh rates: ${result.error}. The last saved rates are still in use.` });
  res.json({ ...result, table: await getRatesTable() });
});

// manualRate = رقم (1 دولار = كام) يثبّت السعر، أو null يرجّعه للتلقائي
const manualSchema = z.object({ manualRate: z.number().positive().max(1_000_000).nullable() });
adminExchangeRatesRouter.patch("/:currency", async (req, res) => {
  const code = req.params.currency.toUpperCase();
  if (!(CURRENCY_CODES as readonly string[]).includes(code) || code === "USD") return res.status(400).json({ error: "Unsupported currency" });
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Rate must be a positive number (1 USD = ?), or null to use the automatic rate" });
  await prisma.exchangeRate.upsert({
    where: { currency: code },
    create: { currency: code, manualRate: parsed.data.manualRate },
    update: { manualRate: parsed.data.manualRate },
  });
  clearRatesCache();
  res.json(await getRatesTable());
});
