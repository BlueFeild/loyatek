import { prisma } from "../config/db";
import { calendarDateKey, formatCalendarDate } from "../utils/calendarDate";
import { isValidTimeZone, zonedDateHourToUtc } from "../utils/timezone";
import { confirmsOnOrder } from "../modules/payment-settings/payment-methods";
import { getApprovedBookingTemplate, sendBookingTemplate, type TemplateLang } from "../modules/whatsapp/booking-templates";

// تذكير واتساب تلقائي قبل الميعاد (افتراضيًا 24 ساعة) بالقالب المعتمد
// BOOKING_REMINDER. بيشتغل كل 5 دقايق جوه السيرفر. كل حجز بياخد تذكير
// واحد بس (reminderSentAt بيتحجز الأول في الداتابيز قبل الإرسال)

// الحجز ده محتاج تذكير دلوقتي؟ (منطق نقي - متغطي باختبارات)
export function isReminderDue(input: {
  appointmentAt: Date;
  createdAt: Date;
  hoursBefore: number;
  now: Date;
}): "send" | "skip" | "wait" {
  const windowStart = input.appointmentAt.getTime() - input.hoursBefore * 3600 * 1000;
  if (input.now.getTime() >= input.appointmentAt.getTime()) return "skip"; // الميعاد فات
  // حجز اتعمل جوه فترة التذكير (مثلًا حجز النهارده لبكرة الصبح) - كفاية التأكيد
  if (input.createdAt.getTime() >= windowStart) return "skip";
  if (input.now.getTime() >= windowStart) return "send";
  return "wait";
}

export async function runBookingReminders(now: Date = new Date()) {
  // حسابات موقوفة / مؤرشفة مابيتبعتلهاش تذكيرات
  const settingsList = await prisma.bookingSettings.findMany({ where: { reminderEnabled: true, tenant: { OR: [{ accountStatus: "ACTIVE" }, { isPlatformOwner: true }] } } });
  let sent = 0;
  let failed = 0;
  for (const settings of settingsList) {
    const tz = isValidTimeZone(settings.timezone) ? settings.timezone : "Asia/Qatar";
    const lang: TemplateLang = settings.waTemplateLang === "ar" ? "ar" : "en";
    // من غير قالب تذكير معتمد مانلمسش الحجوزات خالص (عشان تتبعت أول ما يتعتمد)
    if (!(await getApprovedBookingTemplate(settings.tenantId, "BOOKING_REMINDER", lang))) continue;
    // الحجوزات من امبارح لحد بعد (ساعات التذكير + يومين) - نطاق صغير بس
    const from = new Date(now.getTime() - 24 * 3600 * 1000);
    const to = new Date(now.getTime() + (settings.reminderHoursBefore + 48) * 3600 * 1000);
    const bookings = await prisma.booking.findMany({
      where: {
        tenantId: settings.tenantId,
        reminderSentAt: null,
        status: { not: "CANCELLED" },
        date: { gte: new Date(calendarDateKey(from) + "T00:00:00Z"), lte: new Date(calendarDateKey(to) + "T00:00:00Z") },
      },
      include: { resource: true },
    });
    for (const b of bookings) {
      // حجز لسه مستني دفع (تحويل/لينك) مايتبعتلوش تذكير لحد ما يتأكد
      if (b.paymentStatus === "AWAITING_PAYMENT" && !confirmsOnOrder(b.paymentMethodType)) continue;
      const appointmentAt = zonedDateHourToUtc(calendarDateKey(b.date), b.hour, tz);
      const decision = isReminderDue({ appointmentAt, createdAt: b.createdAt, hoursBefore: settings.reminderHoursBefore, now });
      if (decision === "wait") continue;
      // حجز الإرسال (عشان لو فيه نسختين من السيرفر مايتبعتش مرتين)
      const claimed = await prisma.booking.updateMany({ where: { id: b.id, reminderSentAt: null }, data: { reminderSentAt: now } });
      if (claimed.count !== 1 || decision === "skip") continue;
      const result = await sendBookingTemplate(
        settings.tenantId,
        "BOOKING_REMINDER",
        lang,
        b.customerPhone,
        { name: b.customerName, business: settings.brandName, resource: b.resource.name, services: (b.services ?? []).join(", ") || "Appointment", date: formatCalendarDate(b.date), time: `${String(b.hour).padStart(2, "0")}:00` },
        b.customerName
      );
      if (result?.ok) sent++;
      else failed++;
    }
  }
  return { sent, failed };
}

let timer: NodeJS.Timeout | null = null;

export function startBookingReminderScheduler(intervalMs = 5 * 60 * 1000) {
  if (timer || process.env.DISABLE_REMINDERS === "1") return;
  const tick = () =>
    runBookingReminders()
      .then((r) => {
        if (r.sent || r.failed) console.log(`[reminders] sent ${r.sent}, failed ${r.failed}`);
      })
      .catch((err) => console.warn(`[reminders] run failed: ${(err as Error)?.message}`));
  setTimeout(tick, Math.min(30 * 1000, intervalMs)).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
