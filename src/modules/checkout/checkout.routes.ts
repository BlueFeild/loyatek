import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { initiateMyFatoorahPayment } from "./myfatoorah";

export const checkoutRouter = Router();

checkoutRouter.use(requireAuth);

const MODULE_PRICES: Record<string, number> = {
  catalog: 29,
  booking: 39,
  wallet: 49,
  whatsapp: 79,
  erp: 99,
};
const YEARLY_DISCOUNT = 0.2;

const createOrderSchema = z.object({
  selectedModules: z.array(z.enum(["erp", "booking", "wallet", "whatsapp", "catalog"])).min(1),
  billingCycle: z.enum(["monthly", "yearly"]).default("monthly"),
  currency: z.string().default("USD"),
});

// إنشاء طلب اشتراك حقيقي وفاتورة دفع حقيقية على MyFatoorah - الطلب
// بيفضل PENDING حتى لو الدفع نجح، لحد ما السوبر أدمن يفعّله يدويًا
checkoutRouter.post("/orders", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { selectedModules, billingCycle, currency } = parsed.data;
  const monthlyTotal = selectedModules.reduce((sum, m) => sum + (MODULE_PRICES[m] ?? 0), 0);
  const amount = billingCycle === "yearly" ? Math.round(monthlyTotal * 12 * (1 - YEARLY_DISCOUNT)) : monthlyTotal;

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

checkoutRouter.get("/orders", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});
