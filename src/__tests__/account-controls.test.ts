import { describe, expect, it } from "vitest";
import { getEffectiveModules, isInGrace, isModuleActive, isTrialActive } from "../utils/modules";
import { deniedForTenant } from "../utils/account-access";
import { extraCompanyAmount, modulesOrderAmount } from "../modules/checkout/pricing";

const DAY = 86400000;
const now = new Date("2026-10-15T12:00:00Z");
const base = { subscribedModules: ["booking"], moduleExpirations: {}, trialExpiresAt: null as Date | null };

describe("grace period", () => {
  const expired2DaysAgo = { ...base, moduleExpirations: { booking: new Date(now.getTime() - 2 * DAY).toISOString() } };

  it("expired module is off without grace", () => {
    expect(isModuleActive(expired2DaysAgo, "booking", now, 0)).toBe(false);
  });
  it("still on inside the grace days, with a grace flag", () => {
    expect(isModuleActive(expired2DaysAgo, "booking", now, 3)).toBe(true);
    expect(isInGrace(expired2DaysAgo, "booking", now, 3)).toBe(true);
    expect(getEffectiveModules(expired2DaysAgo, now, 3)).toEqual(["booking"]);
  });
  it("off after the grace days end", () => {
    expect(isModuleActive(expired2DaysAgo, "booking", now, 1)).toBe(false);
  });
  it("a module that hasn't expired is not 'in grace'", () => {
    const future = { ...base, moduleExpirations: { booking: new Date(now.getTime() + DAY).toISOString() } };
    expect(isInGrace(future, "booking", now, 3)).toBe(false);
    expect(isModuleActive(future, "booking", now, 0)).toBe(true);
  });
});

describe("paused / archived accounts", () => {
  it("everything is off when paused, even trial and non-expiring modules", () => {
    const paused = { ...base, accountStatus: "SUSPENDED", trialExpiresAt: new Date(now.getTime() + DAY) };
    expect(isModuleActive(paused, "booking", now, 30)).toBe(false);
    expect(isTrialActive(paused, now)).toBe(false);
    expect(getEffectiveModules(paused, now, 30)).toEqual([]);
  });
  it("platform owner can never be closed", () => {
    expect(isModuleActive({ ...base, accountStatus: "SUSPENDED", isPlatformOwner: true }, "erp", now)).toBe(true);
    expect(deniedForTenant({ accountStatus: "ARCHIVED", isPlatformOwner: true })).toBeNull();
  });
  it("clear messages for login / sessions", () => {
    expect(deniedForTenant({ accountStatus: "ACTIVE" })).toBeNull();
    expect(deniedForTenant({ accountStatus: "SUSPENDED", statusReason: "unpaid" })?.message).toMatch(/paused \(unpaid\)/);
    expect(deniedForTenant({ accountStatus: "ARCHIVED" })?.code).toBe("ACCOUNT_ARCHIVED");
  });
});

describe("prices set by the super admin", () => {
  const pricing = { modulePrices: { booking: 50, catalog: 20 }, extraCompanyBasePrice: 25, yearlyDiscount: 0.25 };
  it("orders use the new prices", () => {
    expect(modulesOrderAmount(["booking", "catalog"], "monthly", pricing)).toBe(70);
    expect(modulesOrderAmount(["booking"], "yearly", pricing)).toBe(450); // 50*12*0.75
    expect(extraCompanyAmount(["booking"], "monthly", pricing)).toBe(75);
  });
  it("default prices unchanged when nothing is set", () => {
    expect(modulesOrderAmount(["booking"], "monthly")).toBe(39);
  });
});
