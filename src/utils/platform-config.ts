import { prisma } from "../config/db";
import { EXTRA_COMPANY_BASE_MONTHLY_PRICE, MODULE_PRICES, YEARLY_DISCOUNT, type Pricing } from "../modules/checkout/pricing";
import { isModuleActive } from "./modules";

// إعدادات المنصة اللي السوبر أدمن بيغيّرها من اللوحة (أسعار الخدمات + أيام
// السماح الافتراضية). متخزنة في platform_settings، ولو مفيش = القيم الافتراضية
// اللي في pricing.ts. بتتخزن في الذاكرة 30 ثانية عشان كل طلب مايسألش الداتابيز
export interface PlatformConfig {
  pricing: Pricing;
  defaultGraceDays: number;
}

let cache: { at: number; value: PlatformConfig } | null = null;

export function clearPlatformConfigCache() {
  cache = null;
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
  };
  cache = { at: Date.now(), value };
  return value;
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
