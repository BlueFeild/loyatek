// مصدر واحد للأسعار - الباك إند هو اللي بيحسب السعر الفعلي، والفرونت
// بيعرضه من نفس الأرقام عن طريق GET /api/checkout/pricing.
// الأرقام دي هي الافتراضي - السوبر أدمن يقدر يغيّرها من اللوحة (بتتخزن في
// platform_settings وبتتقري بـ getPlatformConfig في utils/platform-config.ts)،
// والتغيير بيطبق على الطلبات الجديدة بس
export const MODULE_PRICES: Record<string, number> = {
  catalog: 29,
  booking: 39,
  wallet: 49,
  whatsapp: 79,
  erp: 99,
  linktree: 10,
};
export const YEARLY_DISCOUNT = 0.2;
// رسوم فتح بروفايل/شركة إضافية شهريًا (من غير أي خدمات) - رقم قابل للتعديل
export const EXTRA_COMPANY_BASE_MONTHLY_PRICE = 19;

export interface Pricing {
  modulePrices: Record<string, number>;
  extraCompanyBasePrice: number;
  yearlyDiscount: number;
}

export const DEFAULT_PRICING: Pricing = {
  modulePrices: MODULE_PRICES,
  extraCompanyBasePrice: EXTRA_COMPANY_BASE_MONTHLY_PRICE,
  yearlyDiscount: YEARLY_DISCOUNT,
};

export function modulesMonthlyTotal(modules: string[], pricing: Pricing = DEFAULT_PRICING): number {
  return Array.from(new Set(modules)).reduce((sum, m) => sum + (pricing.modulePrices[m] ?? 0), 0);
}

function applyBilling(monthly: number, billingCycle: "monthly" | "yearly", pricing: Pricing): number {
  return billingCycle === "yearly" ? Math.round(monthly * 12 * (1 - pricing.yearlyDiscount)) : monthly;
}

export function modulesOrderAmount(modules: string[], billingCycle: "monthly" | "yearly", pricing: Pricing = DEFAULT_PRICING): number {
  return applyBilling(modulesMonthlyTotal(modules, pricing), billingCycle, pricing);
}

// سعر الشركة الإضافية = رسوم البروفايل + سعر كل خدمة العميل اختارها
export function extraCompanyAmount(modules: string[], billingCycle: "monthly" | "yearly", pricing: Pricing = DEFAULT_PRICING): number {
  return applyBilling(pricing.extraCompanyBasePrice + modulesMonthlyTotal(modules, pricing), billingCycle, pricing);
}
