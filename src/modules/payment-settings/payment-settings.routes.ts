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
    isConnected: Boolean(settings.myFatoorahApiKey),
    myFatoorahIsTest: settings.myFatoorahIsTest,
    keyPreview: settings.myFatoorahApiKey ? `••••${settings.myFatoorahApiKey.slice(-4)}` : null,
  });
});

const updateSchema = z.object({
  myFatoorahApiKey: z.string().trim().min(10),
  myFatoorahIsTest: z.boolean().default(true),
});

paymentSettingsRouter.patch("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateTenantPaymentSettings(req.auth!.tenantId);
  await prisma.tenantPaymentSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: parsed.data,
  });
  res.json({ ok: true });
});
