import { container } from "../core/container";
import { isShuttingDown } from "../utils/shutdown";

// كل دقيقة: سلاسل رسايل واتساب (اللي خدوا التاج يدخلوا + الرسايل اللي جه ميعادها). DISABLE_WHATSAPP_SEQUENCES=1 يوقفه
let timer: NodeJS.Timeout | null = null;

export function startWhatsappSequenceScheduler(intervalMs = 60 * 1000) {
  if (timer || process.env.DISABLE_WHATSAPP_SEQUENCES === "1") return;
  let busy = false;
  const tick = () => {
    if (isShuttingDown()) return;
    if (busy) return;
    busy = true;
    container.sequenceService
      .runDue()
      .then((r) => {
        if (r.enrolled || r.sent || r.stopped || r.failed) console.log(`[whatsapp] sequences: ${r.enrolled} joined, ${r.sent} sent, ${r.stopped} stopped, ${r.failed} failed`);
      })
      .catch((err) => console.warn(`[whatsapp] sequences failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 25 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
