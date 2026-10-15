import { prisma } from "../config/db";
import { syncOrderPayment } from "../modules/checkout/order-activation";

// كل دقيقتين: أي طلب اشتراك لسه PENDING/PAID وليه فاتورة MyFatoorah (آخر 3
// أيام) بنسأل عنه MyFatoorah - لو اتدفع بيتفعّل. كده الخدمة بتتفعّل حتى لو
// العميل قفل الصفحة بعد الدفع ومرجعش للموقع. DISABLE_PAYMENT_SYNC=1 يوقفه
let timer: NodeJS.Timeout | null = null;

export async function runPaymentSync() {
  const since = new Date(Date.now() - 3 * 86400000);
  const orders = await prisma.subscriptionOrder.findMany({
    where: { status: { in: ["PENDING", "PAID"] }, myFatoorahInvoiceId: { not: null }, createdAt: { gte: since } },
    select: { id: true },
    take: 50,
  });
  let activated = 0;
  for (const o of orders) {
    try {
      const r = await syncOrderPayment(o.id);
      if (r.status === "ACTIVATED") activated++;
    } catch (err) {
      console.warn(`[payment-sync] order ${o.id}: ${(err as Error).message}`);
    }
  }
  return { checked: orders.length, activated };
}

export function startPaymentSyncScheduler(intervalMs = 2 * 60 * 1000) {
  if (timer || process.env.DISABLE_PAYMENT_SYNC === "1") return;
  const tick = () =>
    runPaymentSync()
      .then((r) => {
        if (r.activated) console.log(`[payment-sync] activated ${r.activated} paid order(s)`);
      })
      .catch((err) => console.warn(`[payment-sync] run failed: ${(err as Error)?.message}`));
  setTimeout(tick, 20 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
