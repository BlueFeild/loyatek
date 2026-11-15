import { z } from "zod";

// مواعيد الشغل + اختيار الموظف اللي عليه الدور (دوال صافية بدون قاعدة بيانات - سهلة الاختبار)

const time = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, "Use times like 09:00");
const range = z.tuple([time, time]);
const day = z.array(range).max(4);
export const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const; // 0 = الأحد
export type DayKey = (typeof DAY_KEYS)[number];
export const weekHoursSchema = z.object({ "0": day, "1": day, "2": day, "3": day, "4": day, "5": day, "6": day }).partial();
export type WeekHours = Partial<Record<DayKey, [string, string][]>>;

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function clockParts(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
}

// اليوم والدقيقة في توقيت الشركة
export function localClock(date: Date, timeZone: string): { day: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = clockParts(date, timeZone);
  } catch {
    parts = clockParts(date, "Asia/Qatar");
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: WEEKDAY[get("weekday")] ?? 0, minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

export function hasHours(h: WeekHours | null | undefined) {
  return Boolean(h && DAY_KEYS.some((d) => (h[d]?.length ?? 0) > 0));
}

// مفتوحين دلوقتي؟ مفيش مواعيد متسجلة = مفتوح دايمًا. فترة زي 22:00 → 02:00 بتعدّي نص الليل
export function isOpenAt(hours: WeekHours | null | undefined, timeZone: string, date: Date): boolean {
  if (!hours || !hasHours(hours)) return true;
  const { day, minute } = localClock(date, timeZone);
  const today = hours[String(day) as DayKey] ?? [];
  const yesterday = hours[String((day + 6) % 7) as DayKey] ?? [];
  for (const [from, to] of today) {
    const a = minutes(from);
    const b = minutes(to);
    if (a < b ? minute >= a && minute < b : minute >= a) return true;
  }
  for (const [from, to] of yesterday) {
    const a = minutes(from);
    const b = minutes(to);
    if (a > b && minute < b) return true; // فترة إمبارح اللي عدّت نص الليل
  }
  return false;
}

// الدور: اللي بعد آخر واحد اتعيّن (لو اتشال من القايمة نبدأ من الأول)
export function nextAssignee(userIds: string[], lastAssigned: string | null): string | null {
  if (!userIds.length) return null;
  const i = lastAssigned ? userIds.indexOf(lastAssigned) : -1;
  return userIds[(i + 1) % userIds.length];
}

export function fillName(text: string, name: string | null | undefined) {
  return text
    .replace(/\{name\}/g, (name ?? "").trim())
    .replace(/[ \t]+([,،!.؟?])/g, "$1")
    .trim();
}
