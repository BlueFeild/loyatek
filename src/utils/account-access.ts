import { prisma } from "../config/db";
import { isAccountOpen } from "./modules";

// هل المستخدم ده مسموح له يكمل؟ (المستخدم متوقفش + الشركة مش موقوفة/مؤرشفة)
// بيتسأل في كل طلب بعد التوكن، فبنخزّن النتيجة 10 ثواني بس - يعني الإيقاف
// بيوصل لكل الجلسات المفتوحة خلال ثواني
export type AccessDenied = { code: "USER_DISABLED" | "ACCOUNT_SUSPENDED" | "ACCOUNT_ARCHIVED"; message: string };

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; denied: AccessDenied | null }>();

export function clearAccessCache() {
  cache.clear();
}

export function deniedForTenant(tenant: { accountStatus?: string; isPlatformOwner?: boolean; statusReason?: string | null } | null): AccessDenied | null {
  if (!tenant || isAccountOpen(tenant)) return null;
  if (tenant.accountStatus === "ARCHIVED") {
    return { code: "ACCOUNT_ARCHIVED", message: "This account has been closed. Please contact BlueField to reopen it." };
  }
  return {
    code: "ACCOUNT_SUSPENDED",
    message: `This account is paused${tenant.statusReason ? ` (${tenant.statusReason})` : ""}. Please contact BlueField.`,
  };
}

export async function checkAccess(userId: string, tenantId: string): Promise<AccessDenied | null> {
  const key = `${userId}:${tenantId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.denied;

  const [user, tenant] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { accountStatus: true, isPlatformOwner: true, statusReason: true } }),
  ]);
  let denied: AccessDenied | null = null;
  if (user && !user.isActive) denied = { code: "USER_DISABLED", message: "Your user has been disabled. Please contact your company admin." };
  else denied = deniedForTenant(tenant);

  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), denied });
  return denied;
}
