import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { initiateMyFatoorahPayment } from "./myfatoorah";
import { modulesOrderAmount, extraCompanyAmount } from "./pricing";
import { getRegionalPricing, pricingForCycle } from "../../utils/platform-config";
import { ALL_MODULES } from "../../utils/modules";

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
  selectedModules: z.array(z.enum(ALL_MODULES)).min(1),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  // الدولة اللي العميل شايف أسعارها (العملة والسعر بيتحسبوا هنا مش من الفرونت)
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
});

// إنشاء طلب اشتراك حقيقي وفاتورة دفع حقيقية على MyFatoorah - الطلب
// بيفضل PENDING حتى لو الدفع نجح، لحد ما السوبر أدمن يفعّله يدويًا
checkoutRouter.post("/orders", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { selectedModules, billingCycle, country } = parsed.data;
  const pricing = await getRegionalPricing(country);
  const money = orderMoney(modulesOrderAmount(selectedModules, billingCycle, pricingForCycle(pricing, billingCycle)), pricing);
  const amount = money.amount;

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const order = await prisma.subscriptionOrder.create({
    data: { tenantId: tenant.id, selectedModules, billingCycle, ...money, country: pricing.country },
  });

  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  // MyFatoorah v3 بيستخدم رابط رجوع واحد بس (Redirection) للنجاح
  // والفشل مع بعض - بيضيف paymentId في الآخر، وإحنا اللي بنتأكد من
  // الحالة الحقيقية بنداء GetPaymentDetails بعد كده
  const payment = await initiateMyFatoorahPayment({
    amount,
    currency: money.currency,
    redirectionUrl: `${frontendBase}/checkout/success?orderId=${order.id}`,
  });

  if (!payment.ok) {
    // الطلب لسه محفوظ فعليًا كـ PENDING حتى لو بوابة الدفع مش متوصّلة -
    // السوبر أدمن يقدر يفعّله يدويًا بعد ما يتأكد من الدفع بطريقة تانية
    return res.status(200).json({ order, paymentUrl: null, paymentError: payment.error });
  }

  const updated = await prisma.subscriptionOrder.update({
    where: { id: order.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
  });

  res.status(201).json({ order: updated, paymentUrl: payment.paymentUrl, paymentError: null });
});

const createExtraCompanyOrderSchema = z.object({
  name: z.string().min(2),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
  // الخدمات اللي العميل اختارها للشركة الجديدة (من الـ checklist) - ممكن
  // تبقى فاضية = بروفايل بس من غير خدمات
  selectedModules: z.array(z.enum(MODULE_IDS)).default([]),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
});

// طلب شراء شركة إضافية لنفس المالك - بيعدّي بنفس خط الدفع الحقيقي
// (MyFatoorah) زي اشتراك الموديولات بالظبط، وبيفضل PENDING/PAID لحد
// ما السوبر أدمن يراجعه ويفعّله يدويًا؛ وقت التفعيل (مش قبل كده) هو
// اللي فعليًا بينشئ الشركة الجديدة - يعني مفيش شركة بتتعمل من غير دفع
checkoutRouter.post("/extra-company-orders", requireRole("OWNER"), async (req, res) => {
  const parsed = createExtraCompanyOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, industry, billingCycle, country } = parsed.data;
  const selectedModules = Array.from(new Set(parsed.data.selectedModules));
  const pricing = await getRegionalPricing(country);
  const money = orderMoney(extraCompanyAmount(selectedModules, billingCycle, pricingForCycle(pricing, billingCycle)), pricing);
  const amount = money.amount;

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
    },
  });

  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  const payment = await initiateMyFatoorahPayment({
    amount,
    currency: money.currency,
    redirectionUrl: `${frontendBase}/checkout/success?orderId=${order.id}`,
  });

  if (!payment.ok) {
    return res.status(200).json({ order, paymentUrl: null, paymentError: payment.error });
  }

  const updated = await prisma.subscriptionOrder.update({
    where: { id: order.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
  });

  res.status(201).json({ order: updated, paymentUrl: payment.paymentUrl, paymentError: null });
});

// الأسعار الفعلية اللي الباك إند بيحاسب بيها - الفرونت بيعرض منها بس
checkoutRouter.get("/pricing", async (req, res) => {
  // نفس الأسعار اللي السوبر أدمن حاطها (أو الافتراضي) - بعملة الدولة وبعد الخصم
  res.json(await getRegionalPricing(typeof req.query.country === "string" ? req.query.country : null));
});

checkoutRouter.get("/orders", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});
