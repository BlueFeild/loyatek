import type { Request } from "express";

// عنوان الباك إند العام (لينكات بتتبعت لجوجل/ميتا: لوجو بطاقة الولاء، رابط الـ webhook، صور البوستات).
// تدقيق COM-13: قبل كده لو PUBLIC_API_BASE_URL مش متحدد كنا بناخد الـ Host من الطلب نفسه - وده
// المتصل بيتحكم فيه. دلوقتي: المتغير → دومين Railway → (في التطوير المحلي بس) الـ Host
export function publicApiBaseUrl(req?: Request): string {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  if (req && process.env.NODE_ENV !== "production") {
    const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
    return `${proto}://${req.get("host")}`;
  }
  return `http://localhost:${process.env.PORT || 4000}`;
}
