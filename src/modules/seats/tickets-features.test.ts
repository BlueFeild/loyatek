import { describe, expect, it } from "vitest";
import { layoutSchema } from "./seat-layout";
import { earlyBirdActive, priceOrder, promoInput, promoProblem, type PromoRule } from "./seat-pricing";
import { bestAvailable, lonelySeatLeft } from "./seat-picking";
import { checkAnswers, questionsSchema } from "./seat-questions";
import { csvCell } from "./tickets-admin.service";

const layout = layoutSchema.parse({
  stage: "STAGE",
  rows: [
    { label: "A", count: 6, tier: "vip", aisles: [3] },
    { label: "B", count: 8, tier: "reg" },
  ],
  tiers: [
    { id: "vip", name: "VIP", color: "#F5B301", price: 40 },
    { id: "reg", name: "Regular", color: "#38BDF8", price: 10 },
  ],
  blocked: [],
});
const now = new Date("2026-11-12T10:00:00Z");
const promo = (p: Partial<PromoRule>): PromoRule => ({ id: "p", code: "X", kind: "PERCENT", value: 10, maxUses: null, usedCount: 0, startsAt: null, endsAt: null, eventId: null, tierIds: [], active: true, ...p });

describe("ticket pricing", () => {
  it("early bird only before its end date", () => {
    expect(earlyBirdActive({ pct: 20, endsAt: new Date("2026-11-13T00:00:00Z") }, now)).toBe(20);
    expect(earlyBirdActive({ pct: 20, endsAt: new Date("2026-11-11T00:00:00Z") }, now)).toBe(0);
    expect(earlyBirdActive({ pct: null, endsAt: null }, now)).toBe(0);
  });

  it("applies early bird then promo (percent on eligible levels only)", () => {
    const r = priceOrder(layout, ["A-1", "B-1"], { earlyBird: { pct: 50, endsAt: new Date("2026-12-01") }, promo: promo({ value: 10, tierIds: ["vip"] }), now });
    // 40+10 = 50 full; early bird -> 20 + 5 = 25; promo 10% of VIP (20) = 2
    expect(r).toMatchObject({ subtotal: 50, amount: 23, discount: 27, promoDiscount: 2, earlyBirdPct: 50 });
  });

  it("fixed amount code never goes below zero", () => {
    expect(priceOrder(layout, ["B-1"], { promo: promo({ kind: "AMOUNT", value: 99 }), now }).amount).toBe(0);
  });

  it("explains why a code doesn't work", () => {
    expect(promoProblem(promo({ active: false }), "e1", now)).toMatch(/active/);
    expect(promoProblem(promo({ endsAt: new Date("2026-11-01") }), "e1", now)).toMatch(/expired/);
    expect(promoProblem(promo({ maxUses: 2, usedCount: 2 }), "e1", now)).toMatch(/fully used/);
    expect(promoProblem(promo({ eventId: "e2" }), "e1", now)).toMatch(/show/);
    expect(promoProblem(promo({}), "e1", now)).toBeNull();
  });

  it("validates promo input (upper case, percent ≤ 100)", () => {
    expect(promoInput.parse({ code: "summer-24", kind: "PERCENT", value: 15 }).code).toBe("SUMMER-24");
    expect(promoInput.safeParse({ code: "BIG", kind: "PERCENT", value: 150 }).success).toBe(false);
  });
});

describe("seat picking", () => {
  it("best available = front row, next to each other, near the middle", () => {
    const two = bestAvailable(layout, [], 2)!;
    expect(two.every((s) => s.startsWith("A-"))).toBe(true);
    // A has an aisle after seat 3, so 4 seats together only fit in row B
    expect(bestAvailable(layout, [], 4)!.every((s) => s.startsWith("B-"))).toBe(true);
    expect(bestAvailable(layout, [], 3, "reg")!.every((s) => s.startsWith("B-"))).toBe(true);
    expect(bestAvailable(layout, [], 9)).toBeNull();
  });

  it("never picks taken seats", () => {
    const taken = ["B-3", "B-4", "B-5", "B-6"];
    const pick = bestAvailable(layout, taken, 2, "reg")!;
    expect(pick.some((s) => taken.includes(s))).toBe(false);
  });

  it("refuses to leave one empty seat on its own", () => {
    // row B: picking B-2,B-3 leaves B-1 alone
    expect(lonelySeatLeft(layout, [], ["B-2", "B-3"])).toBe("B-1");
    expect(lonelySeatLeft(layout, [], ["B-1", "B-2"])).toBeNull();
    // A-1..A-3 is a block of 3 (aisle): any pair leaves one seat, so it is allowed
    expect(lonelySeatLeft(layout, [], ["A-1", "A-2"])).toBeNull();
    // gap between taken seats
    expect(lonelySeatLeft(layout, ["B-5"], ["B-3"])).toBe("B-4");
  });
});

describe("checkout questions", () => {
  const qs = questionsSchema.parse([
    { id: "company", label: "Company", required: true },
    { id: "meal", label: "Meal", options: ["Chicken", "Veg"] },
  ]);
  it("requires answers and checks options", () => {
    expect(checkAnswers(qs, {})).toEqual({ ok: false, error: "Please answer: Company" });
    expect(checkAnswers(qs, { company: "ACME", meal: "Fish" }).ok).toBe(false);
    expect(checkAnswers(qs, { company: " ACME ", meal: "Veg", extra: "x" })).toEqual({ ok: true, answers: { company: "ACME", meal: "Veg" } });
  });
});

describe("csv export", () => {
  it("quotes cells and blocks spreadsheet formulas but keeps phone numbers", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+97455551234")).toBe('"+97455551234"');
  });
});
