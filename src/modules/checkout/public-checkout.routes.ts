import { Router } from "express";
import { prisma } from "../../config/db";
import { checkMyFatoorahPaymentStatus, paymentInvoiceMatch } from "./myfatoorah";
import { activateSubscriptionOrder, syncOrderPayment } from "./order-activation";
import { zeroOnUniqueClash } from "../../utils/prisma-errors";

// راوتر عام - العميل بيرجع له من صفحة MyFatoorah بعد الدفع، من غير
// توكن، فمحتاج يكون عام. بنتأكد من حالة الدفع بالسؤال المباشر لـ
// MyFatoorah نفسها (v3 GetPaymentDetails) مش بالثقة في أي حاجة جاية
// في الرابط - الـ paymentId ده MyFatoorah هي اللي بتضيفه في رابط
// الرجوع تلقائيًا بعد الدفع
export const publicCheckoutRouter = Router();

// الرد العام فيه الحالة بس (تدقيق SEC-005): قبل كده كان بيرجّع صف الطلب كله (روابط الدفع وأرقام الفواتير)
function publicOrderView(order: { id: string; status: string; selectedModules: string[]; billingCycle: string; currency: string | null } | null) {
  if (!order) return null;
  return { id: order.id, status: order.status, selectedModules: order.selectedModules, billingCycle: order.billingCycle, currency: order.currency };
}

publicCheckoutRouter.get("/orders/:id/status", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const fresh = async () => publicOrderView(await prisma.subscriptionOrder.findUnique({ where: { id: order.id } }));

  const paymentId = typeof req.query.paymentId === "string" ? req.query.paymentId.slice(0, 100) : undefined;

  // paymentId من الرابط = MyFatoorah بس. طلبات SkipCash بتتأكد تحت برقم الدفعة المتخزن عندنا.
  // تدقيق PAY-01: الدفعة بتتقبل بس لو MyFatoorah قالت صراحة إنها تخص فاتورة الطلب ده ("match").
  // لو الرد مافيهوش رقم فاتورة ("unknown") مانصدّقش الرابط - بنسأل تحت برقم فاتورتنا نفسها
  if (order.status === "PENDING" && paymentId && order.paymentProvider !== "SKIPCASH") {
    const check = await checkMyFatoorahPaymentStatus(paymentId);
    const match = paymentInvoiceMatch(check.raw, order.myFatoorahInvoiceId);
    if (check.paid && match === "match") {
      // القفل: PENDING → PAID مرة واحدة، ورقم الدفعة unique في قاعدة البيانات (مايتستخدمش لطلبين)
      const claimed = await zeroOnUniqueClash(
        prisma.subscriptionOrder.updateMany({ where: { id: order.id, status: "PENDING" }, data: { status: "PAID", myFatoorahPaymentId: paymentId } })
      );
      if (claimed.count === 1) {
        try {
          await activateSubscriptionOrder(order.id);
        } catch (err) {
          console.warn(`[checkout] auto-activation failed for order ${order.id}: ${(err as Error).message}`);
        }
      }
      return res.json(await fresh());
    }
    if (check.paid && match === "mismatch") console.warn(`[checkout] order ${order.id}: paymentId belongs to another invoice — ignored`);
  }

  // من غير paymentId (أو الرد مش واضح): نسأل برقم الفاتورة نفسها
  if (order.status === "PENDING" || order.status === "PAID") {
    try {
      await syncOrderPayment(order.id);
      return res.json(await fresh());
    } catch (err) {
      console.warn(`[checkout] invoice check failed for order ${order.id}: ${(err as Error).message}`);
    }
  }

  res.json(publicOrderView(order));
});
