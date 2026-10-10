// مصدر واحد للأسعار - الباك إند هو اللي بيحسب السعر الفعلي، والفرونت
// بيعرضه من نفس الأرقام عن طريق GET /api/checkout/pricing
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

export function modulesMonthlyTotal(modules: string[]): number {
  return Array.from(new Set(modules)).reduce((sum, m) => sum + (MODULE_PRICES[m] ?? 0), 0);
}

function applyBilling(monthly: number, billingCycle: "monthly" | "yearly"): number {
  return billingCycle === "yearly" ? Math.round(monthly * 12 * (1 - YEARLY_DISCOUNT)) : monthly;
}

export function modulesOrderAmount(modules: string[], billingCycle: "monthly" | "yearly"): number {
  return applyBilling(modulesMonthlyTotal(modules), billingCycle);
}

// سعر الشركة الإضافية = رسوم البروفايل + سعر كل خدمة العميل اختارها
export function extraCompanyAmount(modules: string[], billingCycle: "monthly" | "yearly"): number {
  return applyBilling(EXTRA_COMPANY_BASE_MONTHLY_PRICE + modulesMonthlyTotal(modules), billingCycle);
}
