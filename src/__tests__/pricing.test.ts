import { describe, it, expect } from "vitest";
import { modulesOrderAmount, extraCompanyAmount, MODULE_PRICES } from "../modules/checkout/pricing";

describe("pricing", () => {
  it("every platform module has a price (linktree was missing and billed as 0)", () => {
    for (const m of ["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"]) {
      expect(MODULE_PRICES[m]).toBeGreaterThan(0);
    }
  });
  it("modules order: monthly sum and yearly with 20% off", () => {
    expect(modulesOrderAmount(["catalog", "wallet"], "monthly")).toBe(78);
    expect(modulesOrderAmount(["catalog", "wallet"], "yearly")).toBe(Math.round(78 * 12 * 0.8));
  });
  it("duplicates are only charged once", () => {
    expect(modulesOrderAmount(["wallet", "wallet"], "monthly")).toBe(49);
  });
  it("extra company = base fee + selected services", () => {
    expect(extraCompanyAmount([], "monthly")).toBe(19);
    expect(extraCompanyAmount(["wallet"], "monthly")).toBe(19 + 49);
    expect(extraCompanyAmount(["wallet", "catalog"], "yearly")).toBe(Math.round((19 + 49 + 29) * 12 * 0.8));
  });
  it("unknown module ids add nothing", () => {
    expect(extraCompanyAmount(["nope"], "monthly")).toBe(19);
  });
});
