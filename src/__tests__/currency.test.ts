import { describe, expect, it } from "vitest";
import { FALLBACK_RATES, formatUsdAs, fromUsd, isCurrencyCode, payableAmount, rateFor, toUsd } from "../utils/money";

// العملة الأساسية = دولار: التخزين بالدولار، والعرض/الدفع بعملة الشركة
describe("USD base currency conversion", () => {
  const rates = { ...FALLBACK_RATES, QAR: 3.64, KWD: 0.3075, EGP: 48.5 };

  it("USD stays as is", () => {
    expect(rateFor("USD", rates)).toBe(1);
    expect(fromUsd(10, "USD", rates)).toBe(10);
    expect(toUsd(10, "USD", rates)).toBe(10);
  });

  it("converts USD to the company currency and back without drift", () => {
    expect(fromUsd(10, "QAR", rates)).toBeCloseTo(36.4, 6);
    // التاجر كتب 18 ريال -> يتخزن بالدولار -> يرجع 18.00 ريال بالظبط
    const usd = toUsd(18, "QAR", rates);
    expect(formatUsdAs(usd, "QAR", rates)).toBe("QAR 18.00");
    expect(payableAmount(usd, "QAR", rates)).toBe(18);
    for (const v of [0.5, 1, 7.25, 99.99, 1234.56]) {
      expect(payableAmount(toUsd(v, "EGP", rates), "EGP", rates)).toBe(v);
    }
  });

  it("3-decimal currencies keep 3 decimals when paying", () => {
    expect(payableAmount(10, "KWD", rates)).toBe(3.075);
    expect(formatUsdAs(10, "KWD", rates)).toBe("KWD 3.075");
  });

  it("unknown currency or bad rate falls back safely", () => {
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(rateFor("XYZ", rates)).toBe(1);
    expect(rateFor("QAR", { USD: 1, QAR: 0 } as any)).toBe(FALLBACK_RATES.QAR);
  });
});
