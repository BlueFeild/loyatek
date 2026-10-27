import { describe, expect, it } from "vitest";
import { DEFAULT_META_RATES, MetaCostEstimator, categoryForTemplate, countryForPhone, mergeRates, metaRateTableSchema } from "../modules/whatsapp/meta-rates";
import { MetaRatesService, type MetaRatesStore } from "../modules/whatsapp/meta-rates.service";
import { includedAiCredits, grantIncludedAiCredits } from "../modules/ai/ai-subscription";
import { AI_MODULE_MONTHLY_CREDITS } from "../modules/ai/ai-pricing";
import { CreditService } from "../modules/credits/credit.service";
import { ALL_MODULES } from "../utils/modules";
import { MODULE_PRICES } from "../modules/checkout/pricing";
import { MemoryCredits } from "./helpers/ai-memory-stores";

describe("Meta message cost estimate", () => {
  it("country from the phone's dial code (longest first), else OTHER", () => {
    expect(countryForPhone("+974 5555 1234")).toBe("QA");
    expect(countryForPhone("00966501234567")).toBe("SA");
    expect(countryForPhone("201001234567")).toBe("EG");
    expect(countryForPhone("4915112345678")).toBe("OTHER");
  });
  it("template category → Meta price type (unknown = marketing, the safe/expensive side)", () => {
    expect(categoryForTemplate("UTILITY")).toBe("utility");
    expect(categoryForTemplate("MARKETING")).toBe("marketing");
    expect(categoryForTemplate(null)).toBe("marketing");
  });
  it("estimates per country and in total (Qatar utility = $0.012 like Meta's calculator)", () => {
    const est = new MetaCostEstimator(DEFAULT_META_RATES).estimate(["97455550001", "97455550002", "966501234567", "4915112345678"], "utility");
    expect(est.messages).toBe(4);
    expect(est.byCountry[0]).toEqual({ country: "QA", messages: 2, rate: 0.012, cost: 0.024 });
    expect(est.total).toBeCloseTo(0.024 + 0.0107 + 0.0077, 6);
    expect(est.note).toMatch(/not included in the BlueField price/);
    expect(new MetaCostEstimator(DEFAULT_META_RATES).estimate(Array(32000).fill("97455550001"), "utility").total).toBe(384);
  });
  it("super admin overrides merge over defaults; bad tables are refused", async () => {
    expect(mergeRates({ QA: { marketing: 0.05, utility: 0.02, authentication: 0.02 } }).QA.marketing).toBe(0.05);
    expect(mergeRates({ QA: { marketing: -1 } }).QA.marketing).toBe(DEFAULT_META_RATES.QA.marketing);
    expect(metaRateTableSchema.safeParse({ qatar: { marketing: 1, utility: 1, authentication: 1 } }).success).toBe(false);
    let saved: unknown = {};
    const store: MetaRatesStore = { load: async () => saved, save: async (o) => void (saved = o) };
    const svc = new MetaRatesService(store);
    expect((await svc.rates()).QA.utility).toBe(0.012);
    await svc.replace({ QA: { marketing: 0.04, utility: 0.015, authentication: 0.015 } });
    expect((await svc.rates()).QA.utility).toBe(0.015);
    expect((await svc.estimator()).rateFor("SA", "utility")).toBe(0.0107);
  });
});

describe("AI Studio as a sellable service", () => {
  it("is in the one module list and has a price", () => {
    expect(ALL_MODULES).toContain("ai");
    for (const m of ALL_MODULES) expect(MODULE_PRICES[m]).toBeGreaterThan(0);
  });
  it("subscription adds the credits the super admin set (monthly / yearly)", async () => {
    const plan = { aiMonthlyCredits: 150, aiYearlyCredits: 2000 };
    expect(includedAiCredits("monthly", plan)).toBe(150);
    expect(includedAiCredits("yearly", plan)).toBe(2000);
    expect(AI_MODULE_MONTHLY_CREDITS).toBe(100); // الافتراضي
    const store = new MemoryCredits({ t: { balance: 5, isPlatformOwner: false } });
    expect(await grantIncludedAiCredits(store, null, "t", "yearly", "order-1234-abcd", plan)).toBe(2000);
    expect(store.tenants.t.balance).toBe(2005);
    expect(store.log[0]).toMatchObject({ reason: "AI_SUBSCRIPTION", createdById: null, refId: "order-1234-abcd" });
    expect(await grantIncludedAiCredits(store, null, "t", "monthly", "order-0", { aiMonthlyCredits: 0, aiYearlyCredits: 0 })).toBe(0);
    // فشل الإضافة بيرمي خطأ ← transaction التفعيل كلها بترجع (مفيش تفعيل من غير نقاط)
    await expect(grantIncludedAiCredits(store, null, "missing", "monthly", "order-x", plan)).rejects.toThrow();
  });
  it("trial credits: given once on creation (reason TRIAL, no user), 0 = none", async () => {
    const { TrialCreditsService } = await import("../modules/credits/trial-credits");
    const store = new MemoryCredits({ t: { balance: 0, isPlatformOwner: false } });
    let amount = 20;
    const trial = new TrialCreditsService(new CreditService(store), async () => amount);
    expect(await trial.giveNewCompany("t")).toBe(20);
    expect(store.log[0]).toMatchObject({ amount: 20, note: "Free trial credits", reason: "TRIAL", createdById: null });
    amount = 0;
    expect(await trial.giveNewCompany("t")).toBe(0);
    expect(await trial.giveNewCompany("missing")).toBe(0); // فشلها مايوقفش إنشاء الشركة
    expect(store.tenants.t.balance).toBe(20);
  });
});
