// قايمة الخدمات اللي بتتباع - المصدر الوحيد في الباك إند (الدفع، السوبر أدمن، الأسعار)
export const ALL_MODULES = ["erp", "booking", "wallet", "whatsapp", "catalog", "linktree", "ai"] as const;
export type ModuleId = (typeof ALL_MODULES)[number];

// حالة الحساب كله (السوبر أدمن بيتحكم فيها):
// ACTIVE = شغال، SUSPENDED = موقوف مؤقتًا (دخول + صفحات عامة مقفولة، الداتا
// محفوظة)، ARCHIVED = مقفول ومتشال من اللوحة (ممكن يرجع بـ Restore)
export const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED", "ARCHIVED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

interface TenantLike {
  subscribedModules: string[];
  moduleExpirations: unknown;
  trialExpiresAt: Date | null;
  // شركات صاحب المنصة: كل الخدمات مجانية ودايمة
  isPlatformOwner?: boolean;
  accountStatus?: string;
}

export function isAccountOpen(tenant: { accountStatus?: string; isPlatformOwner?: boolean }): boolean {
  if (tenant.isPlatformOwner) return true;
  return !tenant.accountStatus || tenant.accountStatus === "ACTIVE";
}

// تاريخ انتهاء الموديول (لو متسجّل)
export function moduleExpiry(tenant: TenantLike, moduleId: string): Date | null {
  const expirations = (tenant.moduleExpirations as Record<string, string>) ?? {};
  const v = expirations[moduleId];
  return v ? new Date(v) : null;
}

// موديول واحد بيتحسب "شغال حقيقي" لو الحساب مفتوح، وموجود في subscribedModules،
// ومفيهوش تاريخ انتهاء، أو تاريخ الانتهاء + أيام السماح (graceDays) لسه ما جاش
export function isModuleActive(tenant: TenantLike, moduleId: string, now: Date = new Date(), graceDays = 0): boolean {
  if (!isAccountOpen(tenant)) return false;
  if (tenant.isPlatformOwner) return (ALL_MODULES as readonly string[]).includes(moduleId);
  if (!tenant.subscribedModules.includes(moduleId)) return false;
  const expiresAt = moduleExpiry(tenant, moduleId);
  if (!expiresAt) return true; // مفيش تاريخ انتهاء متسجّل (اشتراك يدوي من غير طلب دفع)
  return expiresAt.getTime() + Math.max(0, graceDays) * DAY_MS > now.getTime();
}

// الموديول خلص بس لسه في فترة السماح (شغال مع تنبيه للتاجر)
export function isInGrace(tenant: TenantLike, moduleId: string, now: Date = new Date(), graceDays = 0): boolean {
  if (!isModuleActive(tenant, moduleId, now, graceDays)) return false;
  const expiresAt = moduleExpiry(tenant, moduleId);
  return Boolean(expiresAt && expiresAt <= now && !tenant.isPlatformOwner);
}

export function getRealActiveModules(tenant: TenantLike, now: Date = new Date(), graceDays = 0): string[] {
  return ALL_MODULES.filter((m) => isModuleActive(tenant, m, now, graceDays));
}

// التجربة المجانية شغالة؟ شركات صاحب المنصة مالهاش تجربة أصلًا - كل
// حاجة مجانية ودايمة، فمايظهرلهاش بانر "Free trial" ولا "اشترك"
export function isTrialActive(tenant: TenantLike, now: Date = new Date()): boolean {
  if (tenant.isPlatformOwner) return false;
  if (!isAccountOpen(tenant)) return false;
  return Boolean(tenant.trialExpiresAt && tenant.trialExpiresAt > now);
}

// الوصول الفعلي في واجهة التاجر = الاشتراك الحقيقي الشغال (شامل السماح) +
// كل حاجة مؤقتًا لو التجربة المجانية لسه شغالة
export function getEffectiveModules(tenant: TenantLike, now: Date = new Date(), graceDays = 0): string[] {
  if (isTrialActive(tenant, now)) return [...ALL_MODULES];
  return getRealActiveModules(tenant, now, graceDays);
}

// مدة الاشتراك بالأيام حسب دورة الفوترة + يوم سماح واحد قبل ما يوقف فعليًا
export function computeExpiryDate(billingCycle: string, from: Date = new Date()): Date {
  const days = billingCycle === "yearly" ? 365 + 1 : 30 + 1;
  return new Date(from.getTime() + days * DAY_MS);
}
