import { Request, Response, NextFunction } from "express";
import { verifyAccessToken, AccessTokenPayload, bypassesAccountChecks } from "../utils/jwt";
import { actorStillAllowed, checkAccess, liveIdentity } from "../utils/account-access";

// إضافة بيانات المستخدم لكل request بعد التحقق من الـ token
declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenPayload;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = header.split(" ")[1];
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // تدقيق AUTH-07: الدور/الفرع/السوبر أدمن من قاعدة البيانات (كاش 10 ثواني) مش من التوكن.
  // مستخدم اتمسح أو اتنقل لشركة تانية = الجلسة خلصت
  const live = await liveIdentity(payload.userId);
  if (!live || live.tenantId !== payload.tenantId) {
    return res.status(401).json({ error: "Your session has ended — please sign in again", code: "SESSION_ENDED" });
  }
  if (!live.isActive && !payload.impersonatedBy) {
    return res.status(403).json({ error: "Your user has been disabled. Please contact your company admin.", code: "USER_DISABLED" });
  }
  if (payload.impersonatedBy) {
    // اللي داخل نيابةً لسه سوبر أدمن / وكالة مسؤولة عن الشركة / المالك لسه مربوط بيها؟
    if (!(await actorStillAllowed(payload.impersonatedBy, payload.tenantId, payload.impersonationKind))) {
      return res.status(401).json({ error: "Your access to this company has ended — please sign in again", code: "SESSION_ENDED" });
    }
  }
  payload = {
    ...payload,
    role: live.role,
    branchId: live.branchId,
    // جلسة نيابةً دايمًا بتتصرف كتاجر عادي؛ غير كده السوبر أدمن = اللي في قاعدة البيانات دلوقتي
    isSuperAdmin: payload.impersonatedBy ? false : live.isSuperAdmin,
  };
  req.auth = payload; // بيحتوي على tenantId و role و branchId

  // شركة موقوفة / مؤرشفة أو مستخدم متوقف: كل الجلسات المفتوحة بتقف خلال ثواني.
  // السوبر أدمن (حتى وهو داخل كشركة) بيقدر يفتح عشان يراجع - التنقل بين شركات المالك لأ
  if (!bypassesAccountChecks(payload)) {
    const denied = await checkAccess(payload.userId, payload.tenantId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  next();
}

// Middleware للتحقق من صلاحية الدور (Role-Based Access Control)
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthenticated" });
    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions for this action" });
    }
    next();
  };
}

// بيسمح بس لصاحب المنصة (مش تاجر عادي) - بيشوف كل الشركات المسجّلة
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: "Unauthenticated" });
  if (!req.auth.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}
