import { describe, expect, it } from "vitest";
import { normalizePromoCode, promoDiscount, promoInput, promoPatch, promoProblem, promoProblemMessage, totalAfterPromo, type PromoRule } from "./promo.logic";

const now = new Date("2026-11-26T12:00:00Z");
const rule = (over: Partial<PromoRule> = {}): PromoRule => ({
  id: "p1",
  code: "SAVE10",
  kind: "PERCENT",
  value: 10,
  minOrderUsd: null,
  maxUses: null,
  usedCount: 0,
  startsAt: null,
  endsAt: null,
  active: true,
  ...over,
});

describe("promo discount", () => {
  it("percent of the subtotal", () => {
    expect(promoDiscount(rule({ value: 10 }), 50)).toBe(5);
    expect(totalAfterPromo(50, 5)).toBe(45);
  });
  it("fixed amount never goes past the subtotal (total not below 0)", () => {
    expect(promoDiscount(rule({ kind: "AMOUNT", value: 30 }), 20)).toBe(20);
    expect(totalAfterPromo(20, 20)).toBe(0);
    expect(promoDiscount(rule({ kind: "AMOUNT", value: 7.5 }), 20)).toBe(7.5);
  });
  it("100% = free, nothing on a zero subtotal", () => {
    expect(promoDiscount(rule({ value: 100 }), 12.34)).toBe(12.34);
    expect(promoDiscount(rule(), 0)).toBe(0);
  });
  it("rounds to 6 decimals (USD storage)", () => {
    const d = promoDiscount(rule({ value: 15 }), 10.274725);
    expect(d).toBe(1.541209);
    expect(totalAfterPromo(10.274725, d)).toBe(8.733516);
  });
});

describe("promo problems", () => {
  it("ok when active and inside the dates", () => {
    expect(promoProblem(rule({ startsAt: new Date("2026-11-01"), endsAt: new Date("2026-12-01") }), 50, now)).toBeNull();
  });
  it("inactive / not started / expired / used up", () => {
    expect(promoProblem(rule({ active: false }), 50, now)?.code).toBe("PROMO_INVALID");
    expect(promoProblem(rule({ startsAt: new Date("2026-12-01") }), 50, now)?.code).toBe("PROMO_NOT_STARTED");
    expect(promoProblem(rule({ endsAt: new Date("2026-11-26T11:59:59Z") }), 50, now)?.code).toBe("PROMO_EXPIRED");
    expect(promoProblem(rule({ endsAt: now }), 50, now)?.code).toBe("PROMO_EXPIRED");
    expect(promoProblem(rule({ maxUses: 2, usedCount: 2 }), 50, now)?.code).toBe("PROMO_USED_UP");
    expect(promoProblem(rule({ maxUses: 2, usedCount: 1 }), 50, now)).toBeNull();
  });
  it("minimum order", () => {
    const p = promoProblem(rule({ minOrderUsd: 30 }), 29.99, now);
    expect(p).toEqual({ code: "PROMO_MIN_ORDER", minOrderUsd: 30 });
    expect(promoProblemMessage(p!, (u) => `QAR ${(u * 3.64).toFixed(2)}`)).toBe("Spend at least QAR 109.20 to use this code.");
    expect(promoProblem(rule({ minOrderUsd: 30 }), 30, now)).toBeNull();
    // من غير مبلغ (فحص بس) الحد الأدنى مايتحسبش
    expect(promoProblem(rule({ minOrderUsd: 30 }), null, now)).toBeNull();
  });
  it("nothing to pay", () => {
    expect(promoProblem(rule(), 0, now)?.code).toBe("PROMO_NOTHING_TO_PAY");
  });
});

describe("promo input", () => {
  it("uppercases the code and refuses bad ones", () => {
    expect(promoInput.parse({ code: "save10", kind: "PERCENT", value: 10 }).code).toBe("SAVE10");
    expect(promoInput.safeParse({ code: "sa ve", kind: "PERCENT", value: 10 }).success).toBe(false);
    expect(promoInput.safeParse({ code: "AB", kind: "PERCENT", value: 10 }).success).toBe(false);
    expect(normalizePromoCode(" save 10 ")).toBe("SAVE10");
  });
  it("percent over 100 and end before start refused", () => {
    expect(promoInput.safeParse({ code: "BIG", kind: "PERCENT", value: 101 }).success).toBe(false);
    expect(promoInput.safeParse({ code: "BIG", kind: "AMOUNT", value: 101 }).success).toBe(true);
    expect(promoInput.safeParse({ code: "DATE", kind: "AMOUNT", value: 5, startsAt: "2026-12-02", endsAt: "2026-12-01" }).success).toBe(false);
    expect(promoPatch.safeParse({ active: false }).success).toBe(true);
    expect(promoPatch.safeParse({ unknown: 1 }).success).toBe(false);
  });
});
