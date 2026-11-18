import { describe, expect, it } from "vitest";
import { dayRange, describeOpeningHours, openHoursForDay, weeklyHoursSchema, weeklyOpenHours } from "../modules/booking/opening-hours";

const base = { openHour: 9, closeHour: 13, disabledHours: [11] };
// 2026-11-20 = الجمعة (5) ، 2026-11-21 = السبت (6)
describe("opening hours per day", () => {
  it("no weekly hours = same hours every day, break removed", () => {
    expect(openHoursForDay(base, "2026-11-20")).toEqual([9, 10, 12]);
  });

  it("closed day, own hours for one day, others fall back", () => {
    const s = { ...base, weeklyHours: { "5": null, "6": { open: 10, close: 12 } } };
    expect(openHoursForDay(s, "2026-11-20")).toEqual([]);
    expect(openHoursForDay(s, "2026-11-21")).toEqual([10]);
    expect(openHoursForDay(s, "2026-11-22")).toEqual([9, 10, 12]);
    expect(dayRange(s, "2026-11-20")).toBeNull();
  });

  it("holiday closes the whole day", () => {
    expect(openHoursForDay({ ...base, holidays: ["2026-12-18"] }, "2026-12-18")).toEqual([]);
  });

  it("broken stored value is ignored (falls back to every day)", () => {
    expect(openHoursForDay({ ...base, weeklyHours: { "5": { open: 12, close: 10 } } }, "2026-11-20")).toEqual([9, 10, 12]);
  });

  it("weekly capacity + text for the AI assistant", () => {
    const s = { ...base, weeklyHours: { "5": null } };
    expect(weeklyOpenHours(s)).toBe(18);
    expect(describeOpeningHours(s)).toContain("Friday closed");
    expect(weeklyHoursSchema.safeParse({ "1": { open: 18, close: 9 } }).success).toBe(false);
  });
});
