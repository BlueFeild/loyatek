import { shippingService } from "../modules/store/shipping/shipping.wiring";
import { openTenantIds } from "../utils/account-access";
import { isShuttingDown } from "../utils/shutdown";

// كل ساعتين: تتبّع شحنات المتجر اللي لسه ماوصلتش (Aramex / FedEx / DHL). اتسلّمت = الطلب بيبقى DELIVERED.
// DISABLE_SHIPPING_TRACKING=1 يوقفه، SHIPPING_TRACKING_INTERVAL_MS يغيّر المدة
let timer: NodeJS.Timeout | null = null;

export function startShippingTrackingScheduler(intervalMs = 2 * 3600 * 1000) {
  if (timer || process.env.DISABLE_SHIPPING_TRACKING === "1") return;
  let busy = false;
  const tick = () => {
    if (isShuttingDown() || busy) return;
    busy = true;
    shippingService
      .runTracking({ isOpen: openTenantIds, olderThanMs: Math.min(90 * 60_000, Math.max(60_000, intervalMs - 60_000)) })
      .then((r) => {
        if (r.checked) console.log(`[shipping] tracking: ${r.updated} updated, ${r.delivered} delivered, ${r.failed} failed`);
      })
      .catch((err) => console.warn(`[shipping] tracking job failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, Math.min(5 * 60 * 1000, intervalMs)).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
