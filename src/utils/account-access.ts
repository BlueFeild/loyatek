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
  identityCache.clear();
  actorCache.clear();
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

// ---------------------------------------------------------------------------
// تدقيق AUTH-07: الدور والفرع وصلاحية السوبر أدمن كانوا بيتاخدوا من التوكن (عمره 15 دقيقة) -
// يعني لو اتشال الأدمن من حد أو اتنقل لـ STAFF، فضل بصلاحياته القديمة لحد ما التوكن يخلص، والمستخدم
// المتمسوح كان بيعدّي. دلوقتي بنقرا الحقيقة من قاعدة البيانات (مع كاش 10 ثواني) ونكتبها فوق التوكن.
export interface LiveIdentity {
  tenantId: string;
  role: string;
  branchId: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  isAgencyStaff: boolean;
}

const identityCache = new Map<string, { at: number; value: LiveIdentity | null }>();
const actorCache = new Map<string, { at: number; ok: boolean }>();

export function clearIdentityCache() {
  identityCache.clear();
  actorCache.clear();
}

export async function liveIdentity(userId: string): Promise<LiveIdentity | null> {
  const hit = identityCache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, branchId: true, isActive: true, isSuperAdmin: true, isAgencyStaff: true },
  });
  if (identityCache.size > 5000) identityCache.clear();
  identityCache.set(userId, { at: Date.now(), value });
  return value;
}

// اللي داخل "نيابةً" (سوبر أدمن / وكالة / المالك بيتنقل بين شركاته) لسه من حقه يدخل الشركة دي؟
export async function actorStillAllowed(actorId: string, tenantId: string, kind: "manage" | "switch" | undefined): Promise<boolean> {
  const key = `${actorId}:${tenantId}:${kind ?? "legacy"}`;
  const hit = actorCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  const actor = await liveIdentity(actorId);
  let ok = false;
  if (actor && actor.isActive) {
    if (kind === "switch") {
      ok = Boolean(await prisma.companyMembership.findUnique({ where: { ownerUserId_tenantId: { ownerUserId: actorId, tenantId } }, select: { id: true } }));
    } else if (actor.isSuperAdmin) {
      ok = true;
    } else if (actor.isAgencyStaff) {
      ok = Boolean(await prisma.agencyAssignment.findUnique({ where: { staffUserId_clientTenantId: { staffUserId: actorId, clientTenantId: tenantId } }, select: { id: true } }));
    }
  }
  if (actorCache.size > 5000) actorCache.clear();
  actorCache.set(key, { at: Date.now(), ok });
  return ok;
}
