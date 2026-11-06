import { container } from "../core/container";

// كل ساعة: أول ما الشهر يبدأ، بيبعت إيميل تقرير الشهر اللي فات لكل شركة مفعّلة الإيميل الشهري
// (مرة واحدة للشهر - lastSentPeriod). DISABLE_SOCIAL_REPORTS=1 يوقفه
let timer: NodeJS.Timeout | null = null;

export function startSocialReportScheduler(intervalMs = 60 * 60 * 1000) {
  if (timer || process.env.DISABLE_SOCIAL_REPORTS === "1") return;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    container.socialReportService
      .sendMonthly()
      .then((r) => {
        if (r.sent) console.log(`[social-reports] emailed ${r.sent} monthly report(s) for ${r.period}`);
      })
      .catch((err) => console.warn(`[social-reports] run failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
