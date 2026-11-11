import { describe, expect, it } from "vitest";
import { ALL_MODULES, isModuleActive, normalizeModules } from "../utils/modules";
import { readDiscounts } from "../utils/platform-config";

describe("Social Media & Ads = one service", () => {
  it("ads and audit are no longer separate services", () => {
    expect(ALL_MODULES).toContain("social");
    expect(ALL_MODULES as readonly string[]).not.toContain("ads");
    expect(ALL_MODULES as readonly string[]).not.toContain("audit");
  });

  it("old names become social without duplicates", () => {
    expect(normalizeModules(["ads", "booking"])).toEqual(["social", "booking"]);
    expect(normalizeModules(["social", "ads", "audit"])).toEqual(["social"]);
    expect(normalizeModules([])).toEqual([]);
  });

  it("one social subscription opens posts, ads and audit (they all check 'social')", () => {
    const tenant = { subscribedModules: ["social"], moduleExpirations: {}, trialExpiresAt: null };
    expect(isModuleActive(tenant, "social")).toBe(true);
  });

  it("a saved discount on the old Paid Ads moves to Social instead of applying to everything", () => {
    const rules = readDiscounts([{ id: "r1", modules: ["ads"], pct: 10, cycle: "both", countries: [] }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].modules).toEqual(["social"]);
    const legacy = readDiscounts({ audit: { pct: 15, endsAt: null } });
    expect(legacy[0].modules).toEqual(["social"]);
  });
});
