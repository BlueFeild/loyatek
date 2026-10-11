// تاريخ الحجز "يوم في التقويم" (YYYY-MM-DD) مش لحظة زمنية - لازم يفضل نفس
// اليوم مهما كانت المنطقة الزمنية للسيرفر أو العميل (قطر UTC+3، مصر...).
// العمود في قاعدة البيانات @db.Date، وبنمثّله دايمًا كـ منتصف الليل UTC.
// قبل كده كان setHours(0) بتوقيت السيرفر بيزحلق اليوم ليوم قبله.

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})/;

// "2026-10-17" (أو Date) -> منتصف ليل 17 أكتوبر UTC. null لو مش تاريخ صحيح
export function parseCalendarDate(input: string | Date): Date | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const m = DATE_KEY.exec(input.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // يرفض تواريخ مش موجودة زي 2026-02-31 (Date.UTC كان هيقلبها لمارس)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

// Date (منتصف ليل UTC) -> "2026-10-17"
export function calendarDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// للرسايل (واتساب / إشعارات): "17/10/2026" من غير ما توقيت السيرفر يغيّره
export function formatCalendarDate(date: Date, locale = "en-GB"): string {
  return date.toLocaleDateString(locale, { timeZone: "UTC" });
}

// النهارده كيوم تقويم (UTC)
export function todayCalendarDate(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
