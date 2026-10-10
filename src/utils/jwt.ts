import jwt from "jsonwebtoken";

// القيم دي معروفة لأي حد شاف الكود ده على GitHub - استخدامها في
// production معناه إن أي حد يقدر يزوّر توكن صحيح لأي مستخدم (حتى
// سوبر أدمن) لو عرف الاسم الافتراضي ده. عشان كده لو NODE_ENV=production
// ومفيش سر حقيقي متظبط، السيرفر بيرفض يشتغل من الأساس بدل ما يشتغل
// بأمان وهمي. في بيئة التطوير المحلي بس، بنسمح بقيمة افتراضية عشان
// السرعة، مع تحذير واضح في الـ console
function requireSecret(envVar: string, devFallback: string): string {
  const value = process.env[envVar];
  if (value) return value;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `FATAL: ${envVar} is not set. Refusing to start in production with a known default secret — set a real, random ${envVar} in your environment.`
    );
  }

  console.warn(`⚠️  ${envVar} is not set — using an insecure development-only default. Never deploy this to production.`);
  return devFallback;
}

const ACCESS_SECRET = requireSecret("JWT_ACCESS_SECRET", "dev_access_secret_change_me");
const REFRESH_SECRET = requireSecret("JWT_REFRESH_SECRET", "dev_refresh_secret_change_me");

export interface AccessTokenPayload {
  userId: string;
  tenantId: string;
  role: string;
  branchId: string | null;
  isSuperAdmin: boolean;
  // موجود بس وقت "إدارة نيابة عن شركة عميل" - بيسجّل هوية السوبر أدمن
  // الحقيقي اللي بيدير الحساب، عشان أي حاجة تتعمل تتسجّل تحت شركة
  // العميل الصح، ومع ده نعرف مين اللي عمل الإجراء فعليًا لو احتجنا نراجعه
  impersonatedBy?: string;
}

// Access token قصير العمر - يتبعت مع كل request
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: "15m" });
}

// Refresh token طويل العمر - يتخزن في DB ويستخدم لتجديد الـ access token
export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, REFRESH_SECRET, { expiresIn: "30d" });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { userId: string } {
  return jwt.verify(token, REFRESH_SECRET) as { userId: string };
}
