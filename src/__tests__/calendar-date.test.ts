import { describe, it, expect } from "vitest";
import { parseCalendarDate, calendarDateKey, formatCalendarDate, todayCalendarDate } from "../utils/calendarDate";

describe("تاريخ الحجز = يوم تقويم ثابت (مايتزحلقش مع المنطقة الزمنية)", () => {
  it("السبت 17 أكتوبر يفضل 17 أكتوبر - مهما كان توقيت السيرفر", () => {
    const d = parseCalendarDate("2026-10-17")!;
    expect(d.toISOString()).toBe("2026-10-17T00:00:00.000Z");
    expect(calendarDateKey(d)).toBe("2026-10-17");
    expect(d.getUTCDay()).toBe(6); // السبت
  });

  it("بيقبل تاريخ جاي من toISOString كامل وبياخد اليوم بس", () => {
    expect(calendarDateKey(parseCalendarDate("2026-10-17T21:30:00.000Z")!)).toBe("2026-10-17");
  });

  it("Date جاية من قاعدة البيانات (منتصف ليل UTC) بتفضل نفس اليوم", () => {
    expect(calendarDateKey(parseCalendarDate(new Date("2026-10-17T00:00:00Z"))!)).toBe("2026-10-17");
  });

  it("تواريخ غلط أو مش موجودة بترجع null", () => {
    expect(parseCalendarDate("hello")).toBeNull();
    expect(parseCalendarDate("2026-02-31")).toBeNull();
    expect(parseCalendarDate("2026-13-01")).toBeNull();
    expect(parseCalendarDate(new Date("invalid"))).toBeNull();
  });

  it("الرسالة بتعرض نفس اليوم (17/10/2026) مش اليوم اللي قبله", () => {
    expect(formatCalendarDate(parseCalendarDate("2026-10-17")!)).toBe("17/10/2026");
  });

  it("النهارده = يوم UTC الحالي", () => {
    expect(calendarDateKey(todayCalendarDate(new Date("2026-10-12T23:59:00Z")))).toBe("2026-10-12");
  });
});
