import { describe, expect, it } from "vitest";
import { allSeats, applyEventLayoutChanges, layoutSchema, priceSeats, sampleLayout, SeatLayoutError, seatLabel } from "./seat-layout";

describe("seat layout", () => {
  it("sample hall has VIP + regular seats", () => {
    const l = sampleLayout();
    const seats = allSeats(l);
    expect(seats.length).toBe(2 * 10 + 6 * 14);
    expect(seats.find((s) => s.id === "A-1")?.tier).toBe("vip");
    expect(seats.find((s) => s.id === "C-14")?.tier).toBe("regular");
    expect(seatLabel("C-14")).toBe("C14");
  });

  it("prices seats from their price level", () => {
    const r = priceSeats(sampleLayout(), ["A-1", "A-2", "C-3"]);
    expect(r.amount).toBe(40 + 40 + 15);
  });

  it("refuses unknown, duplicate and blocked seats", () => {
    const l = { ...sampleLayout(), blocked: ["B-5"] };
    expect(() => priceSeats(l, ["Z-1"])).toThrow(SeatLayoutError);
    expect(() => priceSeats(l, ["A-1", "A-1"])).toThrow(SeatLayoutError);
    expect(() => priceSeats(l, ["B-5"])).toThrow(SeatLayoutError);
    // A-11 doesn't exist (row A has 10)
    expect(() => priceSeats(l, ["A-11"])).toThrow(SeatLayoutError);
  });

  it("validates halls", () => {
    const base = sampleLayout();
    expect(layoutSchema.safeParse({ ...base, rows: [...base.rows, { ...base.rows[0] }] }).success).toBe(false); // row twice
    expect(layoutSchema.safeParse({ ...base, rows: [{ label: "A", count: 5, tier: "nope" }] }).success).toBe(false); // unknown tier
    expect(layoutSchema.safeParse({ ...base, rows: Array.from({ length: 30 }, (_, i) => ({ label: "R" + i, count: 60, tier: "vip" })) }).success).toBe(false); // too many seats
  });

  it("show edits: reprice levels, can't block a sold seat, can't add levels", () => {
    const l = sampleLayout();
    const repriced = applyEventLayoutChanges(l, { tiers: l.tiers.map((t) => (t.id === "vip" ? { ...t, price: 55 } : t)) }, new Set());
    expect(priceSeats(repriced, ["A-1"]).amount).toBe(55);
    expect(() => applyEventLayoutChanges(l, { blocked: ["A-1"] }, new Set(["A-1"]))).toThrow(/already booked/);
    expect(() => applyEventLayoutChanges(l, { tiers: [l.tiers[0]] }, new Set())).toThrow(SeatLayoutError);
    expect(applyEventLayoutChanges(l, { blocked: ["A-1", "nope"] }, new Set()).blocked).toEqual(["A-1"]);
  });
});
