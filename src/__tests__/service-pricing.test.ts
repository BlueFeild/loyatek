import { describe, expect, it } from "vitest";
import { computeBookingAmount, hasPricedServices, pricesForServices, readServicePrices } from "../modules/booking/service-pricing";

// سعر لكل خدمة في الحجز - الإجمالي بيتحسب على السيرفر من الأسعار المحفوظة
describe("booking service prices", () => {
  const settings = { services: ["Haircut", "Beard", "Wash"], servicePrices: { Haircut: 20, Beard: 10, Old: 99 }, paymentAmount: "15" };

  it("one service -> its price", () => {
    expect(computeBookingAmount(settings, ["Haircut"])).toEqual({ services: ["Haircut"], amount: 20, fromServices: true });
  });

  it("two services -> sum of prices", () => {
    expect(computeBookingAmount(settings, ["Haircut", "Beard"]).amount).toBe(30);
  });

  it("ignores unknown / removed services and duplicates (no price tricks)", () => {
    const r = computeBookingAmount(settings, ["Haircut", "Haircut", "Old", "Hacked"]);
    expect(r.services).toEqual(["Haircut"]);
    expect(r.amount).toBe(20);
  });

  it("no service chosen or only unpriced ones -> the fixed amount", () => {
    expect(computeBookingAmount(settings, []).amount).toBe(15);
    expect(computeBookingAmount(settings, ["Wash"])).toEqual({ services: ["Wash"], amount: 15, fromServices: false });
  });

  it("cleans bad stored prices", () => {
    expect(readServicePrices({ A: "5", B: -1, C: "x", D: 0 })).toEqual({ A: 5 });
    expect(readServicePrices(null)).toEqual({});
    expect(pricesForServices(settings.servicePrices, settings.services)).toEqual({ Haircut: 20, Beard: 10 });
    expect(hasPricedServices({}, ["Haircut"])).toBe(false);
    expect(hasPricedServices(settings.servicePrices, settings.services)).toBe(true);
  });
});
