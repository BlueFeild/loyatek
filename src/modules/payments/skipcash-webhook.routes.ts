import { Router, type Request } from "express";
import { prisma } from "../../config/db";
import { container } from "../../core/container";
import { syncOrderPayment } from "../checkout/order-activation";
import { confirmBookingPaymentIfPaid } from "../booking/bookings.service";
import { confirmOrderPaymentIfPaid } from "../catalog/catalog.service";
import { storeService } from "../store/store.routes";
import { SKIPCASH_STATUS } from "./skipcash.gateway";
import type { SkipCashWebhookPayload } from "./skipcash.signature";

// SkipCash بتبعت هنا كل ما حالة دفعة تتغير (https://dev.skipcash.app/doc/web-hooks/).
// - التوقيع في هيدر Authorization (HMAC-SHA256 بالـ Webhook Key) - غلط = 401 ومش بنعمل حاجة.
// - لازم نرد 200 في أقل من 10 ثواني، وإلا بيعيدوا بعد ساعة وبعد يوم.
// - الـ webhook مجرد "جرس": التأكيد الحقيقي دايمًا بسؤال SkipCash عن الدفعة برقمها (نفس طريق رجوع العميل)،
//   والتفعيل/التأكيد بقفل ذرّي - فلو نفس الـ webhook وصل مرتين مفيش حاجة بتحصل مرتين.
// - دفعات مانعرفهاش (محاولات فاشلة بتعمل PaymentId جديد) بنتجاهلها بـ 200.
export const publicSkipCashWebhookRouter = Router();

function payloadOf(req: Request): SkipCashWebhookPayload {
  return req.body && typeof req.body === "object" ? (req.body as SkipCashWebhookPayload) : {};
}

const rawBodyOf = (req: Request) => (req as { rawBody?: Buffer }).rawBody;
const paymentIdOf = (p: SkipCashWebhookPayload) => (typeof p.PaymentId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(p.PaymentId) ? p.PaymentId : null);

// حساب المنصة (اشتراكات الشركات)
publicSkipCashWebhookRouter.post("/", async (req, res) => {
  const p = payloadOf(req);
  const key = container.skipcash.platformCredentials().webhookKey;
  if (!key) {
    console.warn("[skipcash-webhook] platform webhook rejected: SKIPCASH_WEBHOOK_KEY is not set");
    return res.status(401).json({ error: "Invalid signature" });
  }
  if (!container.skipcash.verifyWebhook(p, req.get("authorization"), key, rawBodyOf(req))) {
    console.warn("[skipcash-webhook] platform webhook rejected: signature mismatch");
    return res.status(401).json({ error: "Invalid signature" });
  }
  const paymentId = paymentIdOf(p);
  if (!paymentId || Number(p.StatusId) !== SKIPCASH_STATUS.PAID) return res.json({ ok: true, ignored: true });
  const order = await prisma.subscriptionOrder.findUnique({ where: { skipcashPaymentId: paymentId }, select: { id: true } });
  if (!order) return res.json({ ok: true, ignored: true });
  try {
    const r = await syncOrderPayment(order.id);
    res.json({ ok: true, status: r.status });
  } catch (err) {
    // نرد 200 برضه: الـ sync كل دقيقتين هيكمّل لو حصلت مشكلة مؤقتة
    console.warn(`[skipcash-webhook] order ${order.id}: ${(err as Error).message}`);
    res.json({ ok: true });
  }
});

// حساب التاجر نفسه (حجوزات / منيو / متجر / تذاكر) - الـ token في الرابط بيحدد الشركة
publicSkipCashWebhookRouter.post("/:token", async (req, res) => {
  const p = payloadOf(req);
  const merchant = await container.skipcash.merchantByWebhookToken(req.params.token);
  if (!merchant || !container.skipcash.verifyWebhook(p, req.get("authorization"), merchant.creds.webhookKey, rawBodyOf(req))) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  const paymentId = paymentIdOf(p);
  if (!paymentId || Number(p.StatusId) !== SKIPCASH_STATUS.PAID) return res.json({ ok: true, ignored: true });
  try {
    const handled = await confirmMerchantSkipCashPayment(merchant.tenantId, paymentId);
    res.json({ ok: true, handled });
  } catch (err) {
    console.warn(`[skipcash-webhook] tenant ${merchant.tenantId} payment ${paymentId}: ${(err as Error).message}`);
    res.json({ ok: true });
  }
});

// بندوّر على الحجز/الأوردر اللي الدفعة دي بتاعته (جوه نفس الشركة بس) ونأكّده بنفس دالة رجوع العميل
export async function confirmMerchantSkipCashPayment(tenantId: string, paymentId: string): Promise<string> {
  const where = { tenantId, myFatoorahInvoiceId: paymentId, paymentMethodType: "SKIPCASH" };
  const booking = await prisma.booking.findFirst({ where, select: { id: true } });
  if (booking) {
    await confirmBookingPaymentIfPaid(booking.id);
    return "booking";
  }
  const menuOrder = await prisma.catalogOrder.findFirst({ where, select: { id: true } });
  if (menuOrder) {
    await confirmOrderPaymentIfPaid(menuOrder.id);
    return "menu";
  }
  const seatOrder = await prisma.seatOrder.findFirst({ where, select: { id: true } });
  if (seatOrder) {
    await container.seats.confirmPayment(tenantId, seatOrder.id, undefined);
    return "tickets";
  }
  const storeOrder = await prisma.storeOrder.findFirst({ where, select: { id: true } });
  if (storeOrder) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (tenant?.slug) await storeService.customerOrder(tenant.slug, storeOrder.id);
    return "store";
  }
  return "unknown";
}
