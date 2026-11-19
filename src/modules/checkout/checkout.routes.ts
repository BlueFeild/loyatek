import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { checkoutProvider, moneyForProvider, startSubscriptionPayment, validCheckoutPhone } from "./order-payment";
import { modulesOrderAmount, extraCompanyAmount } from "./pricing";
import { getRegionalPricing, pricingForCycle } from "../../utils/platform-config";
import { visitorCountry } from "../../utils/visitor-country";
import { ALL_MODULES, normalizeModules } from "../../utils/modules";

// المبلغ بخانات العملة (KWD/BHD/OMR/JOD = 3) + نفس المبلغ بالدولار للتقارير
function orderMoney(amount: number, pricing: { currency: string; usdRate: number }) {
  const digits = ["KWD", "BHD", "OMR", "JOD"].includes(pricing.currency) ? 3 : 2;
  const f = 10 ** digits;
  const rounded = Math.round(amount * f) / f;
  return { amount: rounded, currency: pricing.currency, amountUsd: Math.round((rounded / (pricing.usdRate || 1)) * 1e6) / 1e6 };
}

const MODULE_IDS = ALL_MODULES;

export const checkoutRouter = Router();

checkoutRouter.use(requireAuth);

const createOrderSchema = z.object({
  // أسماء قديمة (ads / audit) بتتحوّل لـ social
  selectedModules: z.array(z.string()).transform(normalizeModules).pipe(z.array(z.enum(ALL_MODULES)).min(1)),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  // الدولة اللي العميل شايف أسعارها (العملة والسعر بيتحسبوا هنا مش من الفرونت)
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  // تليفون اللي بيدفع - SkipCash بيطلبه (مش بيتخزن عندنا)
  phone: z.string().trim().max(30).optional(),
});

// البوابة المستخدمة دلوقتي (الصفحة بتعرض الاسم الصح وبتطلب التليفون لو SkipCash)
checkoutRouter.get("/payment-provider", (_req, res) => {
  res.json(checkoutProvider());
});

const PHONE_REQUIRED = { error: "Please add your mobile number — the payment page needs it.", code: "PHONE_REQUIRED" };

// إنشاء طلب اشتراك حقيقي + دفعة حقيقية على بوابة المنصة (SkipCash، أو MyFatoorah لو PAYMENT_PROVIDER=myfatoorah).
// الطلب بيتفعّل تلقائيًا أول ما الدفع يتأكد من البوابة نفسها (رجوع العميل / webhook / sync كل دقيقتين)
checkoutRouter.post("/orders", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { selectedModules, billingCycle, country, phone } = parsed.data;
  const { provider } = checkoutProvider();
  if (provider === "SKIPCASH" && !validCheckoutPhone(phone)) return res.status(400).json(PHONE_REQUIRED);
  // الدولة من السيرفر (الـ IP)، مش اللي الصفحة بعتتها
  const pricing = await getRegionalPricing(visitorCountry(req, country).country);
  // SkipCash = ريال قطري بس (بنحوّل لو أسعار الدولة بعملة تانية)
  const money = await moneyForProvider(orderMoney(modulesOrderAmount(selectedModules, billingCycle, pricingForCycle(pricing, billingCycle)), pricing), provider);

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const order = await prisma.subscriptionOrder.create({
    data: { tenantId: tenant.id, selectedModules, billingCycle, ...money, country: pricing.country, paymentProvider: provider },
  });
  const started = await startSubscriptionPayment(order, { userId: req.auth!.userId, phone });
  res.status(started.paymentUrl ? 201 : 200).json(started);
});

const createExtraCompanyOrderSchema = z.object({
  name: z.string().min(2),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
  // الخدمات اللي العميل اختارها للشركة الجديدة (من الـ checklist) - ممكن
  // تبقى فاضية = بروفايل بس من غير خدمات
  selectedModules: z.array(z.enum(MODULE_IDS)).default([]),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  phone: z.string().trim().max(30).optional(),
});

// طلب شراء شركة إضافية لنفس المالك - بيعدّي بنفس خط الدفع الحقيقي
// (MyFatoorah) زي اشتراك الموديولات بالظبط، وبيفضل PENDING/PAID لحد
// ما السوبر أدمن يراجعه ويفعّله يدويًا؛ وقت التفعيل (مش قبل كده) هو
// اللي فعليًا بينشئ الشركة الجديدة - يعني مفيش شركة بتتعمل من غير دفع
checkoutRouter.post("/extra-company-orders", requireRole("OWNER"), async (req, res) => {
  const parsed = createExtraCompanyOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, industry, billingCycle, country, phone } = parsed.data;
  const { provider } = checkoutProvider();
  if (provider === "SKIPCASH" && !validCheckoutPhone(phone)) return res.status(400).json(PHONE_REQUIRED);
  const selectedModules = Array.from(new Set(parsed.data.selectedModules));
  // الدولة من السيرفر (الـ IP)، مش اللي الصفحة بعتتها
  const pricing = await getRegionalPricing(visitorCountry(req, country).country);
  const money = await moneyForProvider(orderMoney(extraCompanyAmount(selectedModules, billingCycle, pricingForCycle(pricing, billingCycle)), pricing), provider);

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const order = await prisma.subscriptionOrder.create({
    data: {
      tenantId: tenant.id,
      selectedModules,
      billingCycle,
      ...money,
      country: pricing.country,
      orderType: "EXTRA_COMPANY",
      extraCompanyName: name,
      extraCompanyIndustry: industry,
      paymentProvider: provider,
    },
  });
  const started = await startSubscriptionPayment(order, { userId: req.auth!.userId, phone });
  res.status(started.paymentUrl ? 201 : 200).json(started);
});

// الأسعار الفعلية اللي الباك إند بيحاسب بيها - الفرونت بيعرض منها بس
checkoutRouter.get("/pricing", async (req, res) => {
  // نفس الأسعار اللي السوبر أدمن حاطها (أو الافتراضي) - بعملة الدولة وبعد الخصم
  res.json(await getRegionalPricing(visitorCountry(req, req.query.country).country));
});

checkoutRouter.get("/orders", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});
