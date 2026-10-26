import { prisma } from "../config/db";
import { EXTRA_COMPANY_BASE_MONTHLY_PRICE, MODULE_PRICES, YEARLY_DISCOUNT, type Pricing } from "../modules/checkout/pricing";
import { isModuleActive } from "./modules";
import { AI_MODULE_MONTHLY_CREDITS } from "../modules/ai/ai-pricing";
import { getRates, isCurrencyCode, payableAmount, rateFor } from "./money";

// إعدادات المنصة اللي السوبر أدمن بيغيّرها من اللوحة: أسعار الخدمات (بالدولار)،
// قواعد خصم (خدمات + نسبة + شهري/سنوي + دول + تاريخ انتهاء)، أسعار مختلفة لكل
// دولة بعملتها (وخصم سنوي خاص بيها)، وأيام السماح. متخزنة في platform_settings،
// ولو مفيش = القيم الافتراضية اللي في pricing.ts. بتتخزن في الذاكرة 30 ثانية
export type BillingCycle = "monthly" | "yearly";
export interface ModuleDiscount {
  pct: number; // 1 - 90
  endsAt: string | null; // null = لحد ما يتشال
}
// قاعدة خصم: modules فاضية = كل الخدمات، countries فاضية = كل الدول
export interface DiscountRule extends ModuleDiscount {
  id: string;
  modules: string[];
  cycle: "both" | BillingCycle;
  countries: string[];
}
export interface PricingRegion {
  country: string; // ISO (EG / QA / ...)
  name: string;
  currency: string;
  // سعر كل خدمة شهريًا بعملة الدولة (خدمة مش متحدد سعرها = سعر الدولار متحوّل)
  modulePrices: Record<string, number>;
  extraCompanyBasePrice: number | null;
  // خصم الاشتراك السنوي للدولة دي (null = نفس الخصم العام)
  yearlyDiscountPct: number | null;
}
export interface PlatformConfig {
  pricing: Pricing;
  defaultGraceDays: number;
  // مدة التجربة المجانية لأي شركة جديدة (أيام)
  defaultTrialDays: number;
  defaultTrialCredits: number;
  aiMonthlyCredits: number;
  aiYearlyCredits: number;
  discounts: DiscountRule[];
  regions: PricingRegion[];
}

let cache: { at: number; value: PlatformConfig } | null = null;

export function clearPlatformConfigCache() {
  cache = null;
}

const CODE = /^[A-Z]{2}$/;

// الشكل الجديد = لستة قواعد. الشكل القديم ({ erp: { pct, endsAt } }) بيتحوّل
// لقاعدة لكل خدمة (شهري وسنوي، كل الدول) - عشان الخصومات المحفوظة ماتضيعش
export function readDiscounts(raw: unknown): DiscountRule[] {
  const list: any[] = Array.isArray(raw)
    ? raw
    : Object.entries((raw as Record<string, any>) ?? {}).map(([k, v]) => ({ id: `legacy-${k}`, modules: [k], pct: v?.pct, endsAt: v?.endsAt, cycle: "both", countries: [] }));
  const out: DiscountRule[] = [];
  list.forEach((v, i) => {
    const pct = Number(v?.pct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 90) return;
    const modules = (Array.isArray(v?.modules) ? v.modules : []).filter((m: unknown) => typeof m === "string" && m in MODULE_PRICES);
    // القاعدة كانت على خدمات مش موجودة -> نشيلها بدل ما تبقى "كل الخدمات"
    if (Array.isArray(v?.modules) && v.modules.length > 0 && modules.length === 0) return;
    out.push({
      id: typeof v?.id === "string" && v.id ? v.id : `rule-${i + 1}`,
      modules,
      pct: Math.round(pct * 100) / 100,
      endsAt: typeof v?.endsAt === "string" && v.endsAt ? v.endsAt : null,
      cycle: v?.cycle === "monthly" || v?.cycle === "yearly" ? v.cycle : "both",
      countries: (Array.isArray(v?.countries) ? v.countries : []).map((c: unknown) => String(c).toUpperCase()).filter((c: string) => CODE.test(c)),
    });
  });
  return out;
}

function readRegions(raw: unknown): PricingRegion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.country === "string" && isCurrencyCode(r.currency))
    .map((r) => {
      const prices: Record<string, number> = {};
      for (const [k, v] of Object.entries(r.modulePrices ?? {})) {
        const n = Number(v);
        if (k in MODULE_PRICES && Number.isFinite(n) && n >= 0 && v !== null && v !== "") prices[k] = n;
      }
      const extra = Number(r.extraCompanyBasePrice);
      const yd = Number(r.yearlyDiscountPct);
      return {
        country: String(r.country).toUpperCase(),
        name: String(r.name ?? r.country),
        currency: r.currency,
        modulePrices: prices,
        extraCompanyBasePrice: r.extraCompanyBasePrice != null && Number.isFinite(extra) ? extra : null,
        yearlyDiscountPct: r.yearlyDiscountPct != null && r.yearlyDiscountPct !== "" && Number.isFinite(yd) && yd >= 0 && yd <= 90 ? yd : null,
      };
    });
}

export async function getPlatformConfig(): Promise<PlatformConfig> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const row = await prisma.platformSettings.findUnique({ where: { id: "singleton" } });
  const overrides = (row?.modulePrices as Record<string, unknown> | null) ?? {};
  const modulePrices: Record<string, number> = { ...MODULE_PRICES };
  for (const [k, v] of Object.entries(overrides)) {
    const n = Number(v);
    if (k in modulePrices && Number.isFinite(n) && n >= 0) modulePrices[k] = n;
  }
  const value: PlatformConfig = {
    pricing: {
      modulePrices: modulePrices as Pricing["modulePrices"],
      extraCompanyBasePrice: row?.extraCompanyBasePrice != null ? Number(row.extraCompanyBasePrice) : EXTRA_COMPANY_BASE_MONTHLY_PRICE,
      yearlyDiscount: row?.yearlyDiscountPct != null ? row.yearlyDiscountPct / 100 : YEARLY_DISCOUNT,
    },
    defaultGraceDays: row?.defaultGraceDays ?? 3,
    defaultTrialDays: row?.defaultTrialDays ?? 1,
    defaultTrialCredits: row?.defaultTrialCredits ?? 20,
    aiMonthlyCredits: row?.aiMonthlyCredits ?? AI_MODULE_MONTHLY_CREDITS,
    aiYearlyCredits: row?.aiYearlyCredits ?? AI_MODULE_MONTHLY_CREDITS * 12,
    discounts: readDiscounts(row?.moduleDiscounts),
    regions: readRegions(row?.pricingRegions),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function isDiscountActive(d: ModuleDiscount | undefined | null, now: Date = new Date()): d is ModuleDiscount {
  return Boolean(d && d.pct > 0 && (!d.endsAt || new Date(d.endsAt) > now));
}

// أكبر خصم شغال على الخدمة دي، للدولة دي، لنوع الاشتراك ده (شهري/سنوي)
export function bestDiscount(rules: DiscountRule[], moduleId: string, country: string | null, cycle: BillingCycle, now: Date = new Date()): DiscountRule | null {
  let best: DiscountRule | null = null;
  for (const r of rules) {
    if (!isDiscountActive(r, now)) continue;
    if (r.modules.length > 0 && !r.modules.includes(moduleId)) continue;
    if (r.cycle !== "both" && r.cycle !== cycle) continue;
    if (r.countries.length > 0 && (!country || !r.countries.includes(country))) continue;
    if (!best || r.pct > best.pct) best = r;
  }
  return best;
}

// الدولة -> العملة اللي هتتعرض ويتدفع بيها (لو مالهاش أسعار خاصة) - نفس جدول
// الفرونت (frontend/src/lib/country.ts). أي دولة تانية = دولار
const EURO = ["AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES", "MC", "SM", "VA", "AD", "ME", "XK"];
export const COUNTRY_CURRENCY: Record<string, string> = {
  QA: "QAR", EG: "EGP", AE: "AED", SA: "SAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD", GB: "GBP", IM: "GBP", JE: "GBP", GG: "GBP",
  ...Object.fromEntries(EURO.map((c) => [c, "EUR"])),
};

// الأسعار اللي العميل في الدولة دي بيشوفها وبيدفعها: بعملة دولته، بعد الخصم،
// ومعاها السعر قبل الخصم. ده هو المصدر الوحيد للسعر (الفرونت مابيبعتش سعر).
// modulePrices = الشهري. yearlyModulePrices = سعر الشهر في الاشتراك السنوي بعد
// قواعد الخصم (وقبل خصم السنوي العام yearlyDiscount اللي بيتطبق على الإجمالي)
export interface RegionalPricing extends Pricing {
  country: string | null;
  currency: string;
  originalPrices: Record<string, number>;
  discounts: Record<string, ModuleDiscount>;
  yearlyModulePrices: Record<string, number>;
  yearlyDiscounts: Record<string, ModuleDiscount>;
  // سعر الدولار بعملة الدولة (لتسجيل قيمة الطلب بالدولار في التقارير)
  usdRate: number;
}

export async function getRegionalPricing(countryRaw?: string | null): Promise<RegionalPricing> {
  const config = await getPlatformConfig();
  const code = countryRaw ? String(countryRaw).toUpperCase().slice(0, 2) : "";
  const country = CODE.test(code) ? code : null;
  const region = country ? config.regions.find((r) => r.country === country) : undefined;
  const currency = region?.currency ?? (country && COUNTRY_CURRENCY[country] && isCurrencyCode(COUNTRY_CURRENCY[country]) ? COUNTRY_CURRENCY[country] : "USD");
  const rates = await getRates();
  const rate = rateFor(currency, rates);
  // سعر محلي: المكتوب للدولة، وإلا الدولار متحوّل ومقرّب (عشان يبان سعر نضيف)
  const local = (usd: number, explicit?: number | null) => (explicit != null ? explicit : currency === "USD" ? usd : roundNice(payableAmount(usd, currency, rates)));
  const after = (price: number, d: ModuleDiscount | null) => (d ? Math.round(price * (1 - d.pct / 100) * 100) / 100 : price);
  const originalPrices: Record<string, number> = {};
  const modulePrices: Record<string, number> = {};
  const yearlyModulePrices: Record<string, number> = {};
  const discounts: Record<string, ModuleDiscount> = {};
  const yearlyDiscounts: Record<string, ModuleDiscount> = {};
  const now = new Date();
  for (const [m, usd] of Object.entries(config.pricing.modulePrices)) {
    const original = local(usd, region?.modulePrices[m]);
    originalPrices[m] = original;
    const dm = bestDiscount(config.discounts, m, country, "monthly", now);
    const dy = bestDiscount(config.discounts, m, country, "yearly", now);
    if (dm) discounts[m] = { pct: dm.pct, endsAt: dm.endsAt };
    if (dy) yearlyDiscounts[m] = { pct: dy.pct, endsAt: dy.endsAt };
    modulePrices[m] = after(original, dm);
    yearlyModulePrices[m] = after(original, dy);
  }
  return {
    country: region?.country ?? country,
    currency,
    modulePrices,
    originalPrices,
    discounts,
    yearlyModulePrices,
    yearlyDiscounts,
    extraCompanyBasePrice: local(config.pricing.extraCompanyBasePrice, region?.extraCompanyBasePrice),
    yearlyDiscount: region?.yearlyDiscountPct != null ? region.yearlyDiscountPct / 100 : config.pricing.yearlyDiscount,
    usdRate: rate,
  };
}

// الأسعار اللي بيتحسب بيها الطلب حسب نوع الاشتراك
export function pricingForCycle(p: RegionalPricing, cycle: BillingCycle): Pricing {
  return { modulePrices: cycle === "yearly" ? p.yearlyModulePrices : p.modulePrices, extraCompanyBasePrice: p.extraCompanyBasePrice, yearlyDiscount: p.yearlyDiscount };
}

// تقريب لطيف للأسعار المتحوّلة (QAR 142 بدل 141.96، EGP 1,890 بدل 1,887.43)
function roundNice(v: number): number {
  if (v >= 1000) return Math.round(v / 10) * 10;
  if (v >= 20) return Math.round(v);
  return Math.round(v * 100) / 100;
}

// أيام السماح الفعلية لشركة: الرقم بتاعها لو السوبر أدمن حطه، غير كده الافتراضي
export async function tenantGraceDays(tenant: { graceDays?: number | null }): Promise<number> {
  if (tenant.graceDays != null) return tenant.graceDays;
  return (await getPlatformConfig()).defaultGraceDays;
}

// للصفحات العامة: الموديول شغال (شامل فترة السماح والحساب مش موقوف)؟
export async function isModuleLive(
  tenant: Parameters<typeof isModuleActive>[0] & { graceDays?: number | null },
  moduleId: string
): Promise<boolean> {
  return isModuleActive(tenant, moduleId, new Date(), await tenantGraceDays(tenant));
}

// نهاية التجربة المجانية لشركة جديدة دلوقتي (حسب الإعداد) - 0 أيام = من غير تجربة
export async function newTrialExpiry(): Promise<Date | null> {
  const days = (await getPlatformConfig()).defaultTrialDays;
  return days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
}
