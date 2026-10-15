import { describe, expect, it } from "vitest";
import { isDiscountActive, COUNTRY_CURRENCY } from "../utils/platform-config";
import { phoneMatch } from "../utils/phone";
import { paymentInvoiceMatch } from "../modules/checkout/myfatoorah";

describe("monthly discounts", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("is active with no end date or a future end date", () => {
    expect(isDiscountActive({ pct: 20, endsAt: null }, now)).toBe(true);
    expect(isDiscountActive({ pct: 20, endsAt: "2026-10-31T23:59:59Z" }, now)).toBe(true);
  });
  it("stops after the end date, and 0% is no discount", () => {
    expect(isDiscountActive({ pct: 20, endsAt: "2026-10-01T00:00:00Z" }, now)).toBe(false);
    expect(isDiscountActive({ pct: 0, endsAt: null }, now)).toBe(false);
    expect(isDiscountActive(undefined, now)).toBe(false);
  });
});

describe("country currencies", () => {
  it("maps Egypt and Qatar to their currencies", () => {
    expect(COUNTRY_CURRENCY.EG).toBe("EGP");
    expect(COUNTRY_CURRENCY.QA).toBe("QAR");
  });
});

describe("phone matching (new numbers have the country code, old ones may not)", () => {
  it("matches the exact number or the same last 8 digits", () => {
    expect(phoneMatch("+97455551234")).toEqual({ OR: [{ customerPhone: "+97455551234" }, { customerPhone: { endsWith: "55551234" } }] });
  });
  it("short numbers match exactly only", () => {
    expect(phoneMatch("1234")).toEqual({ customerPhone: "1234" });
  });
});

describe("payment belongs to the invoice", () => {
  it("match / mismatch / unknown", () => {
    expect(paymentInvoiceMatch({ Data: { Invoice: { Id: 123 } } }, "123")).toBe("match");
    expect(paymentInvoiceMatch({ Data: { Invoice: { Id: 999 } } }, "123")).toBe("mismatch");
    expect(paymentInvoiceMatch({ Data: {} }, "123")).toBe("unknown");
  });
});
