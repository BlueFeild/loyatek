import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { initiateMyFatoorahPayment } from "./myfatoorah";
import {
  MODULE_PRICES,
  YEARLY_DISCOUNT,
  EXTRA_COMPANY_BASE_MONTHLY_PRICE,
  modulesOrderAmount,
  extraCompanyAmount,
} from "./pricing";

const MODULE_IDS = ["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"] as const;

export const checkoutRouter = Router();

checkoutRouter.use(requireAuth);

const createOrderSchema = z.object({
  selectedModules: z.array(z.enum(["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"])).min(1),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  currency: z.string().default("USD"),
});

// إنشاء طلب اشتراك حقيقي وفاتورة دفع حقيقية على MyFatoorah - الطلب
// بيفضل PENDING حتى لو الدفع نجح، لحد ما السوبر أدمن يفعّله يدويًا
checkoutRouter.post("/orders", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { selectedModules, billingCycle, currency } = parsed.data;
  const amount = modulesOrderAmount(selectedModules, billingCycle);

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const order = await prisma.subscriptionOrder.create({
    data: { tenantId: tenant.id, selectedModules, billingCycle, amount, currency },
  });

  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  // MyFatoorah v3 بيستخدم رابط رجوع واحد بس (Redirection) للنجاح
  // والفشل مع بعض - بيضيف paymentId في الآخر، وإحنا اللي بنتأكد من
  // الحالة الحقيقية بنداء GetPaymentDetails بعد كده
  const payment = await initiateMyFatoorahPayment({
    amount,
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
  currency: z.string().default("USD"),
});

// طلب شراء شركة إضافية لنفس المالك - بيعدّي بنفس خط الدفع الحقيقي
// (MyFatoorah) زي اشتراك الموديولات بالظبط، وبيفضل PENDING/PAID لحد
// ما السوبر أدمن يراجعه ويفعّله يدويًا؛ وقت التفعيل (مش قبل كده) هو
// اللي فعليًا بينشئ الشركة الجديدة - يعني مفيش شركة بتتعمل من غير دفع
checkoutRouter.post("/extra-company-orders", requireRole("OWNER"), async (req, res) => {
  const parsed = createExtraCompanyOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, industry, billingCycle, currency } = parsed.data;
  const selectedModules = Array.from(new Set(parsed.data.selectedModules));
  const amount = extraCompanyAmount(selectedModules, billingCycle);

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const order = await prisma.subscriptionOrder.create({
    data: {
      tenantId: tenant.id,
      selectedModules,
      billingCycle,
      amount,
      currency,
      orderType: "EXTRA_COMPANY",
      extraCompanyName: name,
      extraCompanyIndustry: industry,
    },
  });

  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  const payment = await initiateMyFatoorahPayment({
    amount,
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
checkoutRouter.get("/pricing", (_req, res) => {
  res.json({
    modulePrices: MODULE_PRICES,
    extraCompanyBasePrice: EXTRA_COMPANY_BASE_MONTHLY_PRICE,
    yearlyDiscount: YEARLY_DISCOUNT,
  });
});

checkoutRouter.get("/orders", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});
