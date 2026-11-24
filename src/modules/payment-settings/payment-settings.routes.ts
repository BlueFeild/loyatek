import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { prisma } from "../../config/db";
import { getOrCreateTenantPaymentSettings } from "../checkout/myfatoorah";
import { Prisma } from "@prisma/client";
import { container } from "../../core/container";
import { httpsPaymentUrl, normalizePaymentMethods, paymentMethodsInputSchema, resolvePaymentMethods } from "./payment-methods";

// مفتاح MyFatoorah الخاص بكل تاجر لوحده - مش نفس مفتاح المنصة. أي
// تاجر (OWNER/ADMIN) بيوصّل حساب MyFatoorah بتاعه هو عشان فلوس
// حجوزاته/أوردراته تدخل في حسابه هو مباشرة
export const paymentSettingsRouter = Router();

paymentSettingsRouter.use(requireAuth);

paymentSettingsRouter.get("/", async (req, res) => {
  const settings = await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  const skipcash = await container.skipcash.merchantStatus(req.auth!.tenantId);
  // ميرجعش المفتاح كامل للفرونت إند - بس آخر 4 حروف عشان يتأكد إنه محفوظ.
  // الموظف (STAFF) بيشوف أسماء طرق الدفع وبيانات التحويل بس - من غير لينكات الدفع ورابط الـ webhook
  // وأجزاء المفاتيح (تدقيق COM-11)
  const manager = ["OWNER", "ADMIN", "MANAGER"].includes(req.auth!.role);
  const body = {
    // SkipCash: متوصّل ولا لأ + آخر 4 من Key ID + رابط الـ webhook (مفيش أي مفتاح بيرجع)
    skipcash: {
      connected: skipcash.connected,
      isTest: skipcash.isTest,
      keyPreview: skipcash.keyPreview,
      webhookUrl: skipcash.webhookToken ? container.skipcash.merchantWebhookUrl(skipcash.webhookToken) : null,
    },
    provider: settings.provider,
    isConnected: settings.provider === "CUSTOM_LINK" ? Boolean(settings.customPaymentUrl) : Boolean(settings.myFatoorahApiKey),
    myFatoorahIsTest: settings.myFatoorahIsTest,
    keyPreview: settings.myFatoorahApiKey ? `••••${settings.myFatoorahApiKey.slice(-4)}` : null,
    customProviderName: settings.customProviderName,
    customPaymentUrl: settings.customPaymentUrl,
    hasMyFatoorahKey: Boolean(settings.myFatoorahApiKey),
    methods: resolvePaymentMethods(settings),
  };
  if (manager) return res.json(body);
  res.json({
    ...body,
    skipcash: { connected: body.skipcash.connected, isTest: body.skipcash.isTest, keyPreview: null, webhookUrl: null },
    keyPreview: null,
    customPaymentUrl: null,
    methods: body.methods.map(({ url: _url, ...m }) => m),
  });
});

const httpsUrl = httpsPaymentUrl;

// التاجر بيحفظ قايمة طرق الدفع كلها مرة واحدة (إضافة / حذف / ترتيب).
// MyFatoorah في القايمة لازم يكون مفتاحها متسجّل الأول
paymentSettingsRouter.put("/methods", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = paymentMethodsInputSchema.safeParse(req.body);
  // رسالة واحدة مقروءة للتاجر بدل JSON
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid payment methods" });

  const settings = await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  if (parsed.data.methods.some((m) => m.type === "MYFATOORAH") && !settings.myFatoorahApiKey) {
    return res.status(400).json({ error: "Save your MyFatoorah API key first, then add MyFatoorah as a payment method." });
  }

  if (parsed.data.methods.some((m) => m.type === "SKIPCASH") && !(await container.skipcash.merchantStatus(req.auth!.tenantId)).connected) {
    return res.status(400).json({ error: "Connect your SkipCash account first, then add SkipCash as a payment method." });
  }

  const methods = normalizePaymentMethods(parsed.data.methods);
  await prisma.tenantPaymentSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: { methods: methods as unknown as Prisma.InputJsonValue },
  });
  res.json({ ok: true, methods });
});

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

// مفاتيح SkipCash بتاعة التاجر (من لوحة SkipCash بتاعته: Online Payments). بتتحفظ متشفّرة
// وماترجعش أبدًا - الشاشة بتشوف "متوصّل ✓ ••••1234" بس. لازم الأربعة كلهم مع بعض
const skipcashKeysSchema = z.object({
  clientId: z.string().trim().min(8).max(200),
  keyId: z.string().trim().min(8).max(200),
  secretKey: z.string().trim().min(8).max(500),
  webhookKey: z.string().trim().min(8).max(500),
  isTest: z.boolean().default(true),
});

paymentSettingsRouter.put("/skipcash", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = skipcashKeysSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Paste all four SkipCash values: Client ID, Key ID, Secret Key and Webhook Key." });
  await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  const status = await container.skipcash.saveMerchantKeys(req.auth!.tenantId, parsed.data);
  res.json({
    ok: true,
    skipcash: {
      connected: status.connected,
      isTest: status.isTest,
      keyPreview: status.keyPreview,
      webhookUrl: status.webhookToken ? container.skipcash.merchantWebhookUrl(status.webhookToken) : null,
    },
  });
});

// فصل SkipCash: المفاتيح بتتمسح، وطريقة SkipCash بتختفي من صفحات العملاء
paymentSettingsRouter.delete("/skipcash", requireRole("OWNER", "ADMIN"), async (req, res) => {
  await container.skipcash.removeMerchantKeys(req.auth!.tenantId);
  res.json({ ok: true });
});
