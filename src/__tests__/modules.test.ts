import { describe, it, expect } from "vitest";
import { isModuleActive, getEffectiveModules, computeExpiryDate, ALL_MODULES } from "../utils/modules";

function tenant(overrides: Partial<Parameters<typeof isModuleActive>[0]> = {}) {
  return {
    subscribedModules: [],
    moduleExpirations: {},
    trialExpiresAt: null,
    ...overrides,
  };
}

describe("isModuleActive — أهم منطق أمني في النظام (بيحدد هل العميل دافع فعلاً)", () => {
  it("موديول مش موجود في subscribedModules أصلاً = مش شغال", () => {
    const t = tenant({ subscribedModules: [] });
    expect(isModuleActive(t, "catalog")).toBe(false);
  });

  it("موديول موجود ومفيش تاريخ انتهاء متسجّل = شغال (اشتراك يدوي بدون تاريخ)", () => {
    const t = tenant({ subscribedModules: ["catalog"], moduleExpirations: {} });
    expect(isModuleActive(t, "catalog")).toBe(true);
  });

  it("موديول موجود وتاريخ الانتهاء لسه في المستقبل = شغال", () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const t = tenant({ subscribedModules: ["catalog"], moduleExpirations: { catalog: future } });
    expect(isModuleActive(t, "catalog")).toBe(true);
  });

  it("موديول موجود لكن تاريخ الانتهاء فات = مش شغال - أهم حالة أمنية", () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const t = tenant({ subscribedModules: ["catalog"], moduleExpirations: { catalog: past } });
    expect(isModuleActive(t, "catalog")).toBe(false);
  });

  it("انتهاء موديول واحد مايأثرش على موديول تاني نفس الشركة", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const t = tenant({
      subscribedModules: ["catalog", "booking"],
      moduleExpirations: { catalog: past, booking: future },
    });
    expect(isModuleActive(t, "catalog")).toBe(false);
    expect(isModuleActive(t, "booking")).toBe(true);
  });
});

describe("getEffectiveModules — وصول التاجر في الواجهة (تجربة + اشتراك حقيقي)", () => {
  it("تجربة شغالة = كل الموديولات مفتوحة مؤقتًا حتى لو subscribedModules فاضية", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const t = tenant({ subscribedModules: [], trialExpiresAt: future });
    expect(getEffectiveModules(t)).toEqual([...ALL_MODULES]);
  });

  it("تجربة منتهية = effectiveModules ترجع لـ subscribedModules الحقيقي بس", () => {
    const past = new Date(Date.now() - 1000);
    const t = tenant({ subscribedModules: ["wallet"], trialExpiresAt: past });
    expect(getEffectiveModules(t)).toEqual(["wallet"]);
  });

  it("مفيش تجربة خالص ومفيش اشتراك = effectiveModules فاضية تمامًا", () => {
    const t = tenant({ subscribedModules: [], trialExpiresAt: null });
    expect(getEffectiveModules(t)).toEqual([]);
  });
});

describe("computeExpiryDate — حساب مدة الاشتراك", () => {
  it("الاشتراك الشهري = 31 يوم بالظبط (30 + يوم سماح)", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const result = computeExpiryDate("monthly", from);
    const diffDays = Math.round((result.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(31);
  });

  it("الاشتراك السنوي = 366 يوم بالظبط (365 + يوم سماح)", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const result = computeExpiryDate("yearly", from);
    const diffDays = Math.round((result.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(366);
  });
});
