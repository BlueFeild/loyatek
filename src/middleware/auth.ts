import { Request, Response, NextFunction } from "express";
import { verifyAccessToken, AccessTokenPayload } from "../utils/jwt";
import { checkAccess } from "../utils/account-access";

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
  req.auth = payload; // بيحتوي على tenantId و role و branchId

  // شركة موقوفة / مؤرشفة أو مستخدم متوقف: كل الجلسات المفتوحة بتقف خلال ثواني.
  // السوبر أدمن (حتى وهو داخل كشركة) بيقدر يفتح عشان يراجع
  if (!payload.isSuperAdmin && !payload.impersonatedBy) {
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
