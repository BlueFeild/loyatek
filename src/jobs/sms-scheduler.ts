import { smsService } from "../modules/sms/sms.module";
import { isShuttingDown } from "../utils/shutdown";

// كل دقيقة: حملات الـ SMS المجدولة اللي جه ميعادها بتبدأ (+ الحملات اللي وقفت في النص بترجع رصيدها).
// DISABLE_SMS_SCHEDULER=1 يوقفه، SMS_SCHEDULER_INTERVAL_MS يغيّر المدة
let timer: NodeJS.Timeout | null = null;

export function startSmsScheduler(intervalMs = 60 * 1000) {
  if (timer || process.env.DISABLE_SMS_SCHEDULER === "1") return;
  let busy = false;
  const tick = () => {
    if (isShuttingDown()) return;
    if (busy) return;
    busy = true;
    smsService
      .runDue()
      .then((r) => {
        if (r.started || r.failed) console.log(`[sms] scheduled campaigns: ${r.started} started, ${r.failed} failed`);
      })
      .catch((err) => console.warn(`[sms] scheduler failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, Math.min(20 * 1000, intervalMs)).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
