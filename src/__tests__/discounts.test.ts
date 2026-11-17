import { describe, expect, it } from "vitest";
import { activeDiscountPct, applyDiscount, priceView, readServiceDiscounts, activeServiceDiscounts } from "../utils/discount";
import { computeBookingAmount, discountedServicePrices, publicServicePricing } from "../modules/booking/service-pricing";
import { menuItemFinalPrice, publicMenuItem } from "../modules/catalog/menu-pricing";

const now = new Date("2026-11-17T12:00:00Z");
const future = "2026-12-01T00:00:00.000Z";
const past = "2026-11-01T00:00:00.000Z";

describe("discount helper", () => {
  it("active only inside 1-90 and before the end date", () => {
    expect(activeDiscountPct(20, null, now)).toBe(20);
    expect(activeDiscountPct(20, future, now)).toBe(20);
    expect(activeDiscountPct(20, past, now)).toBeNull();
    expect(activeDiscountPct(20, new Date(now), now)).toBeNull(); // ends exactly now = over
    expect(activeDiscountPct(0, null, now)).toBeNull();
    expect(activeDiscountPct(95, null, now)).toBeNull();
    expect(activeDiscountPct(null, null, now)).toBeNull();
    expect(activeDiscountPct("x", null, now)).toBeNull();
  });

  it("applies the percentage with 6 decimals", () => {
    expect(applyDiscount(100, 20)).toBe(80);
    expect(applyDiscount(10, 33)).toBe(6.7);
    expect(applyDiscount(1 / 3, 10)).toBe(0.3);
    expect(applyDiscount(50, null)).toBe(50);
  });

  it("price view: original + active pct + final", () => {
    expect(priceView(100, 25, future, now)).toEqual({ originalPrice: 100, discountPct: 25, finalPrice: 75 });
    expect(priceView(100, 25, past, now)).toEqual({ originalPrice: 100, discountPct: null, finalPrice: 100 });
  });

  it("service discounts: cleans bad rows and drops unknown services", () => {
    const raw = { Cut: { pct: 20, endsAt: null }, Old: { pct: 10 }, Bad: { pct: 99 }, Wash: { pct: 15, endsAt: past }, Junk: "x" };
    expect(readServiceDiscounts(raw, ["Cut", "Wash", "Bad"])).toEqual({ Cut: { pct: 20, endsAt: null }, Wash: { pct: 15, endsAt: past } });
    expect(activeServiceDiscounts(raw, ["Cut", "Wash"], now)).toEqual({ Cut: 20 });
    expect(readServiceDiscounts(null)).toEqual({});
  });
});

describe("booking total with discounts", () => {
  const settings = {
    services: ["Haircut", "Beard", "Wash"],
    servicePrices: { Haircut: 20, Beard: 10, Wash: 0 },
    paymentAmount: "15",
    serviceDiscounts: { Haircut: { pct: 25, endsAt: future }, Beard: { pct: 50, endsAt: past } },
  };

  it("discounted service is charged the final price, expired one full price", () => {
    expect(computeBookingAmount(settings, ["Haircut"], now).amount).toBe(15);
    expect(computeBookingAmount(settings, ["Beard"], now).amount).toBe(10);
    expect(computeBookingAmount(settings, ["Haircut", "Beard"], now).amount).toBe(25);
  });

  it("after the end date everything is full price again", () => {
    expect(computeBookingAmount(settings, ["Haircut"], new Date("2026-12-02T00:00:00Z")).amount).toBe(20);
  });

  it("no discounts column (old rows) = old behaviour", () => {
    const { serviceDiscounts: _d, ...old } = settings;
    expect(computeBookingAmount(old, ["Haircut", "Beard"], now).amount).toBe(30);
  });

  it("public pricing shows original, pct and final", () => {
    expect(discountedServicePrices(settings, now)).toEqual({ Haircut: 15, Beard: 10 });
    expect(publicServicePricing(settings, now)).toEqual({
      Haircut: { originalPrice: 20, discountPct: 25, finalPrice: 15 },
      Beard: { originalPrice: 10, discountPct: null, finalPrice: 10 },
    });
  });
});

describe("menu order total with discounts", () => {
  const items = [
    { price: "12.5", discountPct: 20, discountEndsAt: null, quantity: 2 },
    { price: "8", discountPct: 50, discountEndsAt: new Date(past), quantity: 1 },
    { price: "3", discountPct: null, discountEndsAt: null, quantity: 3 },
  ];

  it("order total uses the discounted price; expired discount = full price", () => {
    const total = items.reduce((sum, i) => sum + menuItemFinalPrice(i, now) * i.quantity, 0);
    expect(menuItemFinalPrice(items[0], now)).toBe(10);
    expect(menuItemFinalPrice(items[1], now)).toBe(8);
    expect(total).toBe(10 * 2 + 8 + 9);
  });

  it("public item: price = final, original kept, expired pct hidden", () => {
    const a = publicMenuItem(items[0], now);
    expect([a.price, a.originalPrice, a.finalPrice, a.discountPct]).toEqual(["10", 12.5, 10, 20]);
    const b = publicMenuItem(items[1], now);
    expect([b.price, b.originalPrice, b.discountPct, b.discountEndsAt]).toEqual(["8", 8, null, null]);
  });
});
