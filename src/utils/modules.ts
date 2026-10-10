export const ALL_MODULES = ["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"] as const;
export type ModuleId = (typeof ALL_MODULES)[number];

interface TenantLike {
  subscribedModules: string[];
  moduleExpirations: unknown;
  trialExpiresAt: Date | null;
  // شركات صاحب المنصة: كل الخدمات مجانية ودايمة
  isPlatformOwner?: boolean;
}

// موديول واحد بيتحسب "شغال حقيقي" لو موجود في subscribedModules ومفيهوش
// تاريخ انتهاء متسجّل، أو تاريخ الانتهاء (شامل يوم السماح) لسه ما جاش
export function isModuleActive(tenant: TenantLike, moduleId: string): boolean {
  if (tenant.isPlatformOwner) return (ALL_MODULES as readonly string[]).includes(moduleId);
  if (!tenant.subscribedModules.includes(moduleId)) return false;
  const expirations = (tenant.moduleExpirations as Record<string, string>) ?? {};
  const expiresAt = expirations[moduleId];
  if (!expiresAt) return true; // مفيش تاريخ انتهاء متسجّل (اشتراك يدوي من غير طلب دفع)
  return new Date(expiresAt) > new Date();
}

export function getRealActiveModules(tenant: TenantLike): string[] {
  return ALL_MODULES.filter((m) => isModuleActive(tenant, m));
}

// الوصول الفعلي في واجهة التاجر = الاشتراك الحقيقي الشغال + كل حاجة
// مؤقتًا لو التجربة المجانية لسه شغالة
export function getEffectiveModules(tenant: TenantLike): string[] {
  const trialActive = Boolean(tenant.trialExpiresAt && tenant.trialExpiresAt > new Date());
  if (trialActive) return [...ALL_MODULES];
  return getRealActiveModules(tenant);
}

// مدة الاشتراك بالأيام حسب دورة الفوترة + يوم سماح واحد قبل ما يوقف فعليًا
export function computeExpiryDate(billingCycle: string, from: Date = new Date()): Date {
  const days = billingCycle === "yearly" ? 365 + 1 : 30 + 1;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
