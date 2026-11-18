import { z } from "zod";
import { parseCalendarDate } from "../../utils/calendarDate";

// مواعيد العمل لكل يوم لوحده + أيام الإجازة.
// weeklyHours: { "0".."6": { open, close } | null }  (0 = الأحد، null = اليوم مقفول)
//   يوم مش موجود في الـ object (أو weeklyHours = null) = المواعيد العامة openHour–closeHour زي الأول.
// holidays: ["YYYY-MM-DD"] أيام مقفولة بالكامل (أعياد، إجازات).
// disabledHours (الاستراحة) بتتشال من كل الأيام زي ما هي.

export type DayHours = { open: number; close: number } | null;
export type WeeklyHours = Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>>;

const dayHoursSchema = z
  .object({ open: z.number().int().min(0).max(23), close: z.number().int().min(1).max(24) })
  .refine((d) => d.close > d.open, { message: "Closing time must be after opening time" })
  .nullable();

export const weeklyHoursSchema = z
  .object({ "0": dayHoursSchema, "1": dayHoursSchema, "2": dayHoursSchema, "3": dayHoursSchema, "4": dayHoursSchema, "5": dayHoursSchema, "6": dayHoursSchema })
  .partial()
  .nullable();

export const holidaysSchema = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-18")).max(100);

export interface OpeningSettings {
  openHour: number;
  closeHour: number;
  disabledHours: number[];
  weeklyHours?: unknown;
  holidays?: string[] | null;
}

function readWeekly(raw: unknown): WeeklyHours | null {
  const parsed = weeklyHoursSchema.safeParse(raw ?? null);
  return parsed.success ? parsed.data : null;
}

// مواعيد يوم معيّن (من غير الاستراحة) - null = مقفول
export function dayRange(settings: OpeningSettings, dateKey: string): { open: number; close: number } | null {
  if ((settings.holidays ?? []).includes(dateKey)) return null;
  const day = parseCalendarDate(dateKey);
  if (!day) return null;
  const weekly = readWeekly(settings.weeklyHours);
  const key = String(day.getUTCDay()) as keyof WeeklyHours;
  if (weekly && key in weekly) return weekly[key] ?? null;
  return { open: settings.openHour, close: settings.closeHour };
}

// الساعات اللي ينفع الحجز فيها في اليوم ده (بعد شيل الاستراحة)
export function openHoursForDay(settings: OpeningSettings, dateKey: string): number[] {
  const range = dayRange(settings, dateKey);
  if (!range) return [];
  const off = new Set(settings.disabledHours);
  const out: number[] = [];
  for (let h = range.open; h < range.close; h++) if (!off.has(h)) out.push(h);
  return out;
}

// متوسط ساعات الشغل في الأسبوع (لنسبة الإشغال)
export function weeklyOpenHours(settings: OpeningSettings): number {
  const off = new Set(settings.disabledHours);
  const weekly = readWeekly(settings.weeklyHours);
  let total = 0;
  for (let d = 0; d < 7; d++) {
    const key = String(d) as keyof WeeklyHours;
    const r = weekly && key in weekly ? weekly[key] ?? null : { open: settings.openHour, close: settings.closeHour };
    if (!r) continue;
    for (let h = r.open; h < r.close; h++) if (!off.has(h)) total++;
  }
  return total;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// نص قصير للمساعد الذكي: "Sunday 9:00–21:00, … Friday closed"
export function describeOpeningHours(settings: OpeningSettings): string {
  const weekly = readWeekly(settings.weeklyHours);
  if (!weekly) return `${settings.openHour}:00 – ${settings.closeHour}:00 every day`;
  return DAY_NAMES.map((name, d) => {
    const key = String(d) as keyof WeeklyHours;
    const r = key in weekly ? weekly[key] ?? null : { open: settings.openHour, close: settings.closeHour };
    return r ? `${name} ${r.open}:00–${r.close}:00` : `${name} closed`;
  }).join(", ");
}
