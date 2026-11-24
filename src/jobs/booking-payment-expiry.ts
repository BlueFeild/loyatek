import { expireUnpaidBookings } from "../modules/booking/bookings.service";
import { isShuttingDown } from "../utils/shutdown";

// كل 5 دقايق: حجوزات الدفع الأونلاين اللي ماتدفعتش في المهلة بتتلغي والميعاد يرجع متاح (تدقيق COM-02).
// DISABLE_BOOKING_PAYMENT_EXPIRY=1 يقفله، BOOKING_PAYMENT_EXPIRY_INTERVAL_MS يغيّر الفترة
let timer: NodeJS.Timeout | null = null;

export function startBookingPaymentExpiryScheduler(intervalMs = 5 * 60 * 1000) {
  if (timer || process.env.DISABLE_BOOKING_PAYMENT_EXPIRY === "1") return;
  let busy = false;
  const tick = () => {
    if (isShuttingDown() || busy) return;
    busy = true;
    expireUnpaidBookings()
      .then((r) => {
        if (r.expired || r.paid) console.log(`[booking-payments] ${r.expired} unpaid bookings expired, ${r.paid} found paid`);
      })
      .catch((err) => console.warn(`[booking-payments] expiry run failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 45 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
