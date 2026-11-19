import { prisma } from "../../config/db";
import { container } from "../../core/container";
import { getRates, payableAmount } from "../../utils/money";
import { initiateMyFatoorahPayment } from "./myfatoorah";
import { platformPaymentProvider, type PlatformProvider } from "../payments/skipcash.service";
import { skipcashPhone } from "../payments/skipcash.signature";

// دفع طلب اشتراك المنصة: البوابة بتتحدد من PAYMENT_PROVIDER (SkipCash افتراضيًا لو مفاتيحه موجودة)

export interface OrderMoney {
  amount: number;
  currency: string;
  amountUsd: number;
}

// SkipCash بيقبض بالريال القطري بس: لو أسعار الدولة بعملة تانية بنحوّل بسعر الصرف بتاعنا،
// والطلب بيتخزن بالمبلغ اللي اتقبض فعلًا (QAR) + نفس الدولار للتقارير
export async function moneyForProvider(money: OrderMoney, provider: PlatformProvider): Promise<OrderMoney> {
  if (provider !== "SKIPCASH" || money.currency === "QAR") return money;
  const rates = await getRates();
  return { amount: payableAmount(money.amountUsd, "QAR", rates), currency: "QAR", amountUsd: money.amountUsd };
}

export function checkoutProvider() {
  const provider = platformPaymentProvider();
  return { provider, needsPhone: provider === "SKIPCASH", currency: provider === "SKIPCASH" ? "QAR" : null };
}

// رقم تليفون مقبول لـ SkipCash؟ (لازم قبل ما نعمل الطلب)
export function validCheckoutPhone(phone: string | undefined) {
  return skipcashPhone(phone);
}

type OrderRow = Awaited<ReturnType<typeof prisma.subscriptionOrder.create>>;

export async function startSubscriptionPayment(order: OrderRow, payer: { userId: string; phone?: string }) {
  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  const returnUrl = `${frontendBase}/checkout/success?orderId=${order.id}`;

  if (order.paymentProvider === "SKIPCASH") {
    const skipcash = container.skipcash;
    if (!skipcash.platformReady()) return { order, paymentUrl: null, paymentError: "Online payment isn't switched on yet." };
    const user = await prisma.user.findUnique({ where: { id: payer.userId }, select: { name: true, email: true } });
    const r = await skipcash.start(skipcash.platformCredentials(), {
      amountQar: Number(order.amount),
      reference: order.id,
      customer: { name: user?.name, email: user?.email, phone: payer.phone },
      returnUrl,
      webhookUrl: skipcash.platformWebhookUrl(),
      subject: "BlueField subscription",
    });
    if (!r.ok) return { order, paymentUrl: null, paymentError: r.error };
    const updated = await prisma.subscriptionOrder.update({ where: { id: order.id }, data: { skipcashPaymentId: r.paymentId, skipcashPaymentUrl: r.payUrl } });
    return { order: updated, paymentUrl: r.payUrl, paymentError: null };
  }

  // MyFatoorah v3 بيستخدم رابط رجوع واحد بس (Redirection) للنجاح والفشل - بيضيف paymentId في الآخر
  const payment = await initiateMyFatoorahPayment({ amount: Number(order.amount), currency: order.currency, redirectionUrl: returnUrl });
  // الطلب لسه محفوظ فعليًا كـ PENDING حتى لو بوابة الدفع مش متوصّلة
  if (!payment.ok) return { order, paymentUrl: null, paymentError: payment.error ?? "Payment failed to start" };
  const updated = await prisma.subscriptionOrder.update({
    where: { id: order.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
  });
  return { order: updated, paymentUrl: payment.paymentUrl ?? null, paymentError: null };
}
