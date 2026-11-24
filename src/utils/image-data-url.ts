import { z } from "zod";

// صورة مرفوعة كـ data URL: PNG / JPG / WEBP / GIF بس (تدقيق COM-14). قبل كده كام حقل كان بيقبل أي نص -
// زي SVG (فيه سكربت) أو text/html - وبيتعرض بعد كده في صفحات عامة. "" = مسح الصورة زي null
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export function imageDataUrlSchema(maxChars = 8_000_000) {
  return z.union([
    z.literal(""),
    z.string().max(maxChars, "This image is too large").regex(IMAGE_DATA_URL, "Use a PNG, JPG, WEBP or GIF image"),
  ]);
}
