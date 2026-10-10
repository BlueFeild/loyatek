import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { prisma } from "../../config/db";
import { getOrCreateTenantPaymentSettings } from "../checkout/myfatoorah";

// مفتاح MyFatoorah الخاص بكل تاجر لوحده - مش نفس مفتاح المنصة. أي
// تاجر (OWNER/ADMIN) بيوصّل حساب MyFatoorah بتاعه هو عشان فلوس
// حجوزاته/أوردراته تدخل في حسابه هو مباشرة
export const paymentSettingsRouter = Router();

paymentSettingsRouter.use(requireAuth);

paymentSettingsRouter.get("/", async (req, res) => {
  const settings = await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  // ميرجعش المفتاح كامل للفرونت إند - بس آخر 4 حروف عشان يتأكد إنه محفوظ
  res.json({
    provider: settings.provider,
    isConnected: settings.provider === "CUSTOM_LINK" ? Boolean(settings.customPaymentUrl) : Boolean(settings.myFatoorahApiKey),
    myFatoorahIsTest: settings.myFatoorahIsTest,
    keyPreview: settings.myFatoorahApiKey ? `••••${settings.myFatoorahApiKey.slice(-4)}` : null,
    customProviderName: settings.customProviderName,
    customPaymentUrl: settings.customPaymentUrl,
  });
});

// رابط الدفع لازم يكون https فقط (مفيش javascript: أو http) لأنه بيتفتح
// للعميل. {amount} و{reference} اختيارية جوه الرابط
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v.replace(/\{(amount|reference)\}/g, "x")).protocol === "https:";
    } catch {
      return false;
    }
  }, "Payment link must be a valid https:// URL");

const updateSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("MYFATOORAH"),
    myFatoorahApiKey: z.string().trim().min(10),
    myFatoorahIsTest: z.boolean().default(true),
  }),
  z.object({
    provider: z.literal("CUSTOM_LINK"),
    customProviderName: z.string().trim().min(1).max(60),
    customPaymentUrl: httpsUrl,
  }),
]);

paymentSettingsRouter.patch("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  // توافق مع النسخة القديمة اللي كانت بتبعت المفتاح بس من غير provider
  const body = req.body && req.body.provider === undefined ? { ...req.body, provider: "MYFATOORAH" } : req.body;
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  await prisma.tenantPaymentSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: parsed.data,
  });
  res.json({ ok: true });
});
