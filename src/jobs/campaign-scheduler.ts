import { container } from "../core/container";

// كل دقيقة: حملات واتساب المجدولة اللي جه ميعادها بتبدأ تتبعت. DISABLE_CAMPAIGN_SCHEDULER=1 يوقفه
let timer: NodeJS.Timeout | null = null;

export function startCampaignScheduler(intervalMs = 60 * 1000) {
  if (timer || process.env.DISABLE_CAMPAIGN_SCHEDULER === "1") return;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    container.campaignSender
      .runDue()
      .then((r) => {
        if (r.started || r.failed) console.log(`[whatsapp] scheduled campaigns: ${r.started} started, ${r.failed} failed`);
      })
      .catch((err) => console.warn(`[whatsapp] scheduler failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 20 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
