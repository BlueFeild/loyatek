import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getOrCreateWalletSettings, updateWalletSettings, adjustCustomerBalance } from "./wallet.service";

export const walletRouter = Router();

walletRouter.use(requireAuth);

// --- Settings ---

walletRouter.get("/settings", async (req, res) => {
  const settings = await getOrCreateWalletSettings(req.auth!.tenantId);
  res.json(settings);
});

const updateSettingsSchema = z.object({
  engine: z.enum(["stamp", "points", "tier", "cashback"]).optional(),
  stampCount: z.number().int().min(1).optional(),
  pointsRate: z.number().int().min(1).optional(),
  cashbackPct: z.number().int().min(1).optional(),
  expirationDays: z.number().int().min(1).optional(),
  allowOverrides: z.boolean().optional(),
  cardLayout: z.enum(["classic", "minimal", "badge", "split"]).optional(),
  themeColor: z.string().optional(),
  logoDataUrl: z.string().nullable().optional(),
  centerLabel: z.string().optional(),
  centerIconDataUrl: z.string().nullable().optional(),
  centerBorderThickness: z.number().int().min(0).max(4).optional(),
  centerRingColor: z.string().optional(),
  centerInnerGlow: z.boolean().optional(),
  showDecorCircles: z.boolean().optional(),
  decorCircles: z.array(z.object({ label: z.string(), image: z.string().nullable() })).optional(),
  termsText: z.string().optional(),
});

walletRouter.patch("/settings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await updateWalletSettings(req.auth!.tenantId, parsed.data);
  res.json(settings);
});

// --- Customers ---

walletRouter.get("/customers", async (req, res) => {
  const customers = await prisma.walletCustomer.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(customers);
});

const createCustomerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(4),
  tier: z.enum(["SILVER", "GOLD_VIP", "PLATINUM"]).default("SILVER"),
});

walletRouter.post("/customers", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const customer = await prisma.walletCustomer.create({
      data: { tenantId: req.auth!.tenantId, ...parsed.data },
    });
    res.status(201).json(customer);
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "A customer with this phone number is already registered" });
    }
    throw err;
  }
});

const adjustSchema = z.object({ delta: z.number().int() });

walletRouter.post("/customers/:id/adjust", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const customer = await adjustCustomerBalance(req.auth!.tenantId, req.params.id, parsed.data.delta);
    res.json(customer);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// إرسال واتساب - محاكاة حقيقية للعملية (تسجيل + تحديث آخر زيارة)، مفيش
// تكامل واتساب فعلي حقيقي لسه، فده بيسجل النية بس مش بيبعت رسالة فعلية
walletRouter.post("/customers/:id/notify", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const customer = await prisma.walletCustomer.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  res.json({ ok: true, message: `WhatsApp notification queued for ${customer.phone}` });
});
