import { Router } from "express";
import { prisma } from "../../config/db";
import { checkMyFatoorahPaymentStatus, paymentAmountMatch, paymentInvoiceMatch } from "./myfatoorah";
import { activateSubscriptionOrder, syncOrderPayment } from "./order-activation";

// راوتر عام - العميل بيرجع له من صفحة MyFatoorah بعد الدفع، من غير
// توكن، فمحتاج يكون عام. بنتأكد من حالة الدفع بالسؤال المباشر لـ
// MyFatoorah نفسها (v3 GetPaymentDetails) مش بالثقة في أي حاجة جاية
// في الرابط - الـ paymentId ده MyFatoorah هي اللي بتضيفه في رابط
// الرجوع تلقائيًا بعد الدفع
export const publicCheckoutRouter = Router();

publicCheckoutRouter.get("/orders/:id/status", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const paymentId = req.query.paymentId as string | undefined;

  if (order.status === "PENDING" && paymentId) {
    const check = await checkMyFatoorahPaymentStatus(paymentId);
    // الدفعة لازم تخص فاتورة الطلب ده ومتكونش اتستخدمت لطلب تاني
    const match = paymentInvoiceMatch(check.raw, order.myFatoorahInvoiceId);
    const reused = check.paid ? await prisma.subscriptionOrder.findFirst({ where: { myFatoorahPaymentId: paymentId, id: { not: order.id } } }) : null;
    if (check.paid && match !== "mismatch" && !reused) {
      await prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "PAID", myFatoorahPaymentId: paymentId } });
      // الدفع اتأكد فعلًا -> الخدمة بتتفعّل على طول (من غير انتظار السوبر أدمن).
      // لو MyFatoorah مارجّعتش رقم فاتورة نقارن بيه، المبلغ لازم يطابق؛ لو
      // مفيش ده ولا ده بيفضل PAID والسوبر أدمن يفعّل
      const amountOk = paymentAmountMatch(check.raw, Number(order.amount));
      if (match === "match" || (match === "unknown" && amountOk === "match")) {
        try {
          await activateSubscriptionOrder(order.id);
        } catch (err) {
          console.warn(`[checkout] auto-activation failed for order ${order.id}: ${(err as Error).message}`);
        }
      } else {
        console.warn(`[checkout] order ${order.id} paid but not auto-activated (invoice ${match}, amount ${amountOk}) — activate it from super admin`);
      }
      return res.json(await prisma.subscriptionOrder.findUnique({ where: { id: order.id } }));
    }
    console.warn(`[checkout] order ${order.id}: paymentId check not paid (status ${check.raw?.Data?.Invoice?.Status ?? check.raw?.Data?.InvoiceStatus ?? "?"}, invoice ${match}) — checking by invoice`);
  }

  // من غير paymentId (أو الرد مش واضح): نسأل برقم الفاتورة نفسها
  if (order.status === "PENDING" || order.status === "PAID") {
    try {
      await syncOrderPayment(order.id);
      return res.json(await prisma.subscriptionOrder.findUnique({ where: { id: order.id } }));
    } catch (err) {
      console.warn(`[checkout] invoice check failed for order ${order.id}: ${(err as Error).message}`);
    }
  }

  res.json(order);
});
