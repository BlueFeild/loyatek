import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db";
import { getEffectiveModules } from "../utils/modules";
import { tenantGraceDays } from "../utils/platform-config";
import { bypassesAccountChecks } from "../utils/jwt";

// هل الشركة دي ليها حق تستخدم موديول معيّن دلوقتي؟ نفس منطق الواجهة بالظبط
// (effectiveModules): اشتراك حقيقي شغال (شامل أيام السماح) أو تجربة مجانية لسه
// شغالة، وشركات صاحب المنصة دايمًا مسموح. النتيجة بتتخزن 10 ثواني بس
const TTL_MS = 10_000;
const cache = new Map<string, { at: number; ok: boolean }>();

export function clearModuleAccessCache() {
  cache.clear();
}

export async function hasModuleAccess(tenantId: string, moduleId: string): Promise<boolean> {
  const key = `${tenantId}:${moduleId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      subscribedModules: true,
      moduleExpirations: true,
      trialExpiresAt: true,
      isPlatformOwner: true,
      accountStatus: true,
      graceDays: true,
    },
  });
  const ok = tenant ? getEffectiveModules(tenant, new Date(), await tenantGraceDays(tenant)).includes(moduleId) : false;

  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), ok });
  return ok;
}

// بيتحط بعد requireAuth: من غير اشتراك (أو تجربة) في الموديول = 403 بكود واضح.
// قبل كده الـ ERP كان مقفول في الواجهة بس، وأي حد معاه توكن يقدر يكلّم الـ API
// السوبر أدمن (وهو داخل كشركة للمراجعة) مسموح له زي الواجهة
export function requireModule(moduleId: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated" });
    if (bypassesAccountChecks(req.auth)) return next();
    if (await hasModuleAccess(req.auth.tenantId, moduleId)) return next();
    return res.status(403).json({
      error: `Your ${moduleId.toUpperCase()} subscription is not active. Subscribe or renew to use it.`,
      code: "MODULE_INACTIVE",
      module: moduleId,
    });
  };
}
