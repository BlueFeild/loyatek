// ميعاد الحجز متخزن "يوم تقويم" + ساعة (بتوقيت البيزنس). عشان نعرف
// اللحظة الحقيقية (للتذكير قبلها بـ 24 ساعة مثلًا) بنحوّلها لـ UTC حسب
// المنطقة الزمنية للبيزنس (Asia/Qatar افتراضيًا) - بغض النظر عن توقيت السيرفر

// فرق التوقيت (بالدقايق) للمنطقة دي في اللحظة دي - مثلًا قطر = +180
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "2026-10-17" + 16 + "Asia/Qatar" -> 2026-10-17T13:00:00Z
export function zonedDateHourToUtc(dateKey: string, hour: number, timeZone: string): Date {
  const [y, m, d] = dateKey.slice(0, 10).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  // مرتين عشان التوقيت الصيفي (لو المنطقة فيها DST)
  let ts = guess - offsetMinutes(timeZone, new Date(guess)) * 60000;
  ts = guess - offsetMinutes(timeZone, new Date(ts)) * 60000;
  return new Date(ts);
}
