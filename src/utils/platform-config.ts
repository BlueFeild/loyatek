import { prisma } from "../config/db";
import { EXTRA_COMPANY_BASE_MONTHLY_PRICE, MODULE_PRICES, YEARLY_DISCOUNT, type Pricing } from "../modules/checkout/pricing";
import { isModuleActive } from "./modules";
import { getRates, isCurrencyCode, payableAmount, rateFor } from "./money";

// إعدادات المنصة اللي السوبر أدمن بيغيّرها من اللوحة: أسعار الخدمات (بالدولار)،
// خصم لكل خدمة بتاريخ انتهاء، أسعار مختلفة لكل دولة بعملتها، وأيام السماح.
// متخزنة في platform_settings، ولو مفيش = القيم الافتراضية اللي في pricing.ts.
// بتتخزن في الذاكرة 30 ثانية عشان كل طلب مايسألش الداتابيز
export interface ModuleDiscount {
  pct: number; // 1 - 90
  endsAt: string | null; // null = لحد ما يتشال
}
export interface PricingRegion {
  country: string; // ISO (EG / QA / ...)
  name: string;
  currency: string;
  // سعر كل خدمة شهريًا بعملة الدولة (خدمة مش متحدد سعرها = سعر الدولار متحوّل)
  modulePrices: Record<string, number>;
  extraCompanyBasePrice: number | null;
}
export interface PlatformConfig {
  pricing: Pricing;
  defaultGraceDays: number;
  discounts: Record<string, ModuleDiscount>;
  regions: PricingRegion[];
}

let cache: { at: number; value: PlatformConfig } | null = null;

export function clearPlatformConfigCache() {
  cache = null;
}

function readDiscounts(raw: unknown): Record<string, ModuleDiscount> {
  const out: Record<string, ModuleDiscount> = {};
  for (const [k, v] of Object.entries((raw as Record<string, any>) ?? {})) {
    const pct = Number(v?.pct);
    if (!(k in MODULE_PRICES) || !Number.isFinite(pct) || pct <= 0 || pct >= 100) continue;
    out[k] = { pct: Math.round(pct * 100) / 100, endsAt: typeof v?.endsAt === "string" && v.endsAt ? v.endsAt : null };
  }
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
      return { country: String(r.country).toUpperCase(), name: String(r.name ?? r.country), currency: r.currency, modulePrices: prices, extraCompanyBasePrice: r.extraCompanyBasePrice != null && Number.isFinite(extra) ? extra : null };
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
    discounts: readDiscounts(row?.moduleDiscounts),
    regions: readRegions(row?.pricingRegions),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function isDiscountActive(d: ModuleDiscount | undefined, now: Date = new Date()): d is ModuleDiscount {
  return Boolean(d && d.pct > 0 && (!d.endsAt || new Date(d.endsAt) > now));
}

// الدولة -> العملة اللي هتتعرض ويتدفع بيها (لو مالهاش أسعار خاصة)
export const COUNTRY_CURRENCY: Record<string, string> = { QA: "QAR", EG: "EGP", AE: "AED", SA: "SAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD", GB: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR" };

// الأسعار اللي العميل في الدولة دي بيشوفها وبيدفعها: بعملة دولته، بعد الخصم،
// ومعاها السعر قبل الخصم. ده هو المصدر الوحيد للسعر (الفرونت مابيبعتش سعر)
export interface RegionalPricing extends Pricing {
  country: string | null;
  currency: string;
  originalPrices: Record<string, number>;
  discounts: Record<string, ModuleDiscount>;
  // سعر الدولار بعملة الدولة (لتسجيل قيمة الطلب بالدولار في التقارير)
  usdRate: number;
}

export async function getRegionalPricing(countryRaw?: string | null): Promise<RegionalPricing> {
  const config = await getPlatformConfig();
  const country = countryRaw ? String(countryRaw).toUpperCase().slice(0, 2) : null;
  const region = country ? config.regions.find((r) => r.country === country) : undefined;
  const currency = region?.currency ?? (country && COUNTRY_CURRENCY[country] && isCurrencyCode(COUNTRY_CURRENCY[country]) ? COUNTRY_CURRENCY[country] : "USD");
  const rates = await getRates();
  const rate = rateFor(currency, rates);
  // سعر محلي: المكتوب للدولة، وإلا الدولار متحوّل ومقرّب (عشان يبان سعر نضيف)
  const local = (usd: number, explicit?: number | null) => (explicit != null ? explicit : currency === "USD" ? usd : roundNice(payableAmount(usd, currency, rates)));
  const originalPrices: Record<string, number> = {};
  const modulePrices: Record<string, number> = {};
  const now = new Date();
  const discounts: Record<string, ModuleDiscount> = {};
  for (const [m, usd] of Object.entries(config.pricing.modulePrices)) {
    const original = local(usd, region?.modulePrices[m]);
    originalPrices[m] = original;
    const d = config.discounts[m];
    if (isDiscountActive(d, now)) {
      discounts[m] = d;
      modulePrices[m] = Math.round(original * (1 - d.pct / 100) * 100) / 100;
    } else modulePrices[m] = original;
  }
  return {
    country: region?.country ?? country,
    currency,
    modulePrices,
    originalPrices,
    discounts,
    extraCompanyBasePrice: local(config.pricing.extraCompanyBasePrice, region?.extraCompanyBasePrice),
    yearlyDiscount: config.pricing.yearlyDiscount,
    usdRate: rate,
  };
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
