import { Router } from "express";
import { prisma } from "../../config/db";
import { checkMyFatoorahPaymentStatus } from "./myfatoorah";

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
    if (check.paid) {
      const updated = await prisma.subscriptionOrder.update({
        where: { id: order.id },
        data: { status: "PAID", myFatoorahPaymentId: paymentId },
      });
      return res.json(updated);
    }
  }

  res.json(order);
});
