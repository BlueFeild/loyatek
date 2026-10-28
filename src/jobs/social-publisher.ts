import { container } from "../core/container";

// كل دقيقة: أي بوست سوشيال جه ميعاده بيتنشر، وأي بوست اتقطع في النص (السيرفر اتعاد
// تشغيله) بيتعلّم FAILED عشان التاجر يعيده. DISABLE_SOCIAL_PUBLISHER=1 يوقفه
let timer: NodeJS.Timeout | null = null;

export function startSocialPublisherScheduler(intervalMs = 60 * 1000) {
  if (timer || process.env.DISABLE_SOCIAL_PUBLISHER === "1") return;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    container.socialPostService
      .runDue()
      .then((r) => {
        if (r.started || r.expired) console.log(`[social] published ${r.started} due post(s), ${r.expired} interrupted`);
      })
      .catch((err) => console.warn(`[social] run failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 15 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
