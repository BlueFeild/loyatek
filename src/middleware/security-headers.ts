import type { NextFunction, Request, Response } from "express";

// هيدرز أمان أساسية لكل رد (تدقيق SEC-003). الـ API بيرجّع JSON وملفات - مفيش صفحات HTML
// بتتعرض من هنا، فمحدش محتاج يحطها في iframe. HSTS على الإنتاج بس (https)
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

// رسايل أخطاء قاعدة البيانات / السيرفر الداخلية (فيها أسماء جداول ومسارات ملفات) ماتطلعش للمستخدم.
// كتير من الـ routes بترجّع err.message زي ما هي - ده بيلقطها في مكان واحد (تدقيق: أخطاء خام)
const INTERNAL = /Invalid `?prisma|PrismaClient|Unique constraint failed|Foreign key constraint|Transaction (API|already)|ECONNREFUSED|ETIMEDOUT|\n\s+at [\w$.<>]+ \(|[A-Z]:\\[^\s]+\.ts|\/src\/[^\s]+\.ts/;

export function isInternalErrorMessage(message: string): boolean {
  return INTERNAL.test(message);
}

export function hideInternalErrors(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      const msg = (body as { error: string }).error;
      if (isInternalErrorMessage(msg)) {
        console.error(`[error] ${req.method} ${req.path}: ${msg.slice(0, 2000)}`);
        return json({ ...(body as object), error: "Something went wrong on our side — please try again." });
      }
    }
    return json(body);
  };
  next();
}
