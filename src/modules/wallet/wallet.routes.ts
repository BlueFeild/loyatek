import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getOrCreateWalletSettings, updateWalletSettings, adjustCustomerBalance } from "./wallet.service";
import { getOrCreateWhatsappSettings, sendWhatsappTestMessage } from "../whatsapp/whatsapp.service";
import {
  WalletFlowError,
  addStampByCode,
  listRecentActivity,
  redeemRewardByCode,
  resolveActor,
  scanByCode,
} from "./wallet-scan.service";
import { queuePassSync } from "./wallet-pass.service";

export const walletRouter = Router();

// memberCode (الكود اللي في الـ QR) سرّي عن الموظفين نفسهم: لو ظهر في
// قايمة العملاء، أي موظف كان هيقدر يختم أو يسلّم هدية من غير ما العميل
// يكون موجود - وده بالظبط اللي الـ scan بيمنعه
function withoutCode<T extends { memberCode?: unknown }>(customer: T) {
  const { memberCode: _hidden, ...rest } = customer;
  return rest;
}

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
  rewardText: z.string().min(1).max(80).optional(),
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
  res.json(customers.map(withoutCode));
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
    res.status(201).json(withoutCode(customer));
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
    const actor = await resolveActor(req.auth!.userId);
    const customer = await adjustCustomerBalance(req.auth!.tenantId, req.params.id, parsed.data.delta, actor);
    queuePassSync(customer.id);
    res.json(withoutCode(customer));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Scan → Stamp → Redeem ---
// الموظف بيعمل scan لـ QR اللي ظاهر عند العميل (أو بيكتب الكود يدوي)،
// والختم والهدية بيتحسبوا بس من خلال الكود ده - مش بالتليفون ولا بالـ id.
// كل حركة بتتسجّل باسم الموظف في سجل المراجعة

const codeSchema = z.object({ code: z.string().trim().min(8).max(128) });
const SCAN_ROLES = ["OWNER", "ADMIN", "MANAGER", "STAFF"] as const;

function sendFlowError(res: any, err: unknown) {
  if (err instanceof WalletFlowError) return res.status(err.status).json({ error: err.message });
  throw err;
}

walletRouter.post("/scan", requireRole(...SCAN_ROLES), async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please scan or enter a valid member code" });
  try {
    res.json(await scanByCode(req.auth!.tenantId, parsed.data.code));
  } catch (err) {
    sendFlowError(res, err);
  }
});

walletRouter.post("/stamp", requireRole(...SCAN_ROLES), async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please scan or enter a valid member code" });
  try {
    const actor = await resolveActor(req.auth!.userId);
    const result = await addStampByCode(req.auth!.tenantId, parsed.data.code, actor);
    queuePassSync(
      result.customer.id,
      result.rewardsEarned > 0 ? { kind: "earned", label: result.rewardText } : undefined
    );
    res.json(result);
  } catch (err) {
    sendFlowError(res, err);
  }
});

walletRouter.post("/redeem", requireRole(...SCAN_ROLES), async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please scan or enter a valid member code" });
  try {
    const actor = await resolveActor(req.auth!.userId);
    const result = await redeemRewardByCode(req.auth!.tenantId, parsed.data.code, actor);
    queuePassSync(result.customer.id, { kind: "redeemed" });
    res.json(result);
  } catch (err) {
    sendFlowError(res, err);
  }
});

// سجل مين عمل إيه على كروت العملاء - للمدير/المالك بس
walletRouter.get("/activity", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(await listRecentActivity(req.auth!.tenantId, limit));
});

// إرسال واتساب حقيقي فعلي عن طريق نفس حساب Meta المتصل بموديول
// WhatsApp Automation - مفيش حساب منفصل مطلوب لبطاقة الولاء، بيستخدم
// نفس الاتصال. لو الحساب مش متصل، بيرفض بصراحة بدل ما يتظاهر إنه بعت
walletRouter.post("/customers/:id/notify", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const customer = await prisma.walletCustomer.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaPhoneNumberId) {
    return res.status(400).json({
      error: "Connect a real Meta WhatsApp Business account from the WhatsApp Automation page first — this loyalty message uses the same connection.",
    });
  }

  const phone = customer.phone.replace(/[^\d]/g, "");
  const result = await sendWhatsappTestMessage(settings.metaAccessToken, settings.metaPhoneNumberId, phone);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ ok: true, message: `Real WhatsApp message sent to ${customer.phone}` });
});
