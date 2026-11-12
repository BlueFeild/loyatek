import { container } from "../core/container";

// تذكير قبل العروض (خدمة التذاكر) كل 5 دقايق - DISABLE_SEAT_REMINDERS=1 يقفله.
// كل طلب بياخد تذكير واحد بس (reminderSentAt بيتحجز الأول قبل الإرسال)
let timer: NodeJS.Timeout | null = null;

export function startSeatReminderScheduler(intervalMs = 5 * 60 * 1000) {
  if (timer || process.env.DISABLE_SEAT_REMINDERS === "1") return;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    container.seats
      .runReminders()
      .then((sent) => {
        if (sent) console.log(`[tickets] reminders sent: ${sent}`);
      })
      .catch((err) => console.warn(`[tickets] reminders failed: ${(err as Error)?.message}`))
      .finally(() => {
        busy = false;
      });
  };
  setTimeout(tick, 30 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
