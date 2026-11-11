import { z } from "zod";

// تصميم صفحة الحجز العامة: التاجر بيختار قالب جاهز ولون وخط، ويرفع غلاف وصور
// للخدمات والأخصائيين. الصور بتتخزن data URL (PNG/JPEG/WebP بس - مش SVG
// عشان مايبقاش فيه سكريبت جوه صورة).

// لازم تفضل نفس القائمة اللي في الفرونت (frontend/src/data/bookingTemplates.ts)
export const BOOKING_TEMPLATES = [
  "classic", "mint", "blush", "sky", "sand", "lavender", "noir",
  "ocean", "forest", "sunset", "mono", "rose", "citrus", "midnight",
] as const;
export const BOOKING_GRADIENTS = ["aurora", "peach", "lagoon", "dusk", "meadow", "candy", "gold", "night"] as const;
export const BOOKING_FONTS = ["modern", "elegant", "rounded"] as const;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

// حجم الصورة كنص (الفرونت بيصغّرها قبل الرفع، ده حد أمان بس)
export const imageDataUrl = (maxChars: number, label: string) =>
  z
    .string()
    .max(maxChars, `${label} is too large — please choose a smaller image`)
    .regex(DATA_URL, `${label} must be a PNG, JPG or WebP image`);

export const COVER_MAX_CHARS = 2_500_000; // ~1.8 MB
function imageDataUrlLazy() {
  return imageDataUrl(COVER_MAX_CHARS, "The background photo");
}
export const THUMB_MAX_CHARS = 700_000; // ~500 KB

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #14B8A6");

// الخلفية: لون القالب، أو لون، أو تدرّج جاهز، أو صورة التاجر (مع تغميق خفيف عشان الكلام يبان)
export const pageBackgroundSchema = z
  .object({
    type: z.enum(["template", "color", "gradient", "image"]),
    color: HEX.optional(),
    gradient: z.enum(BOOKING_GRADIENTS).optional(),
    imageDataUrl: imageDataUrlLazy().optional(),
    dim: z.number().int().min(0).max(80).optional(),
  })
  .strict();

export const pageStyleSchema = z
  .object({
    accent: HEX.nullable().optional(),
    font: z.enum(BOOKING_FONTS).optional(),
    background: pageBackgroundSchema.optional(),
    // شكل الخدمات: لستة / شبكة صور / كروت كبيرة
    layout: z.enum(["list", "grid", "big"]).optional(),
    // مكان العنوان فوق: شمال / نص
    hero: z.enum(["left", "center"]).optional(),
    // الحواف: ناعمة / مدورة جدًا / حادة
    corners: z.enum(["soft", "round", "sharp"]).optional(),
  })
  .strict();

export const serviceDetailSchema = z
  .object({
    imageDataUrl: imageDataUrl(THUMB_MAX_CHARS, "The service photo").nullable().optional(),
    description: z.string().trim().max(200).optional(),
    durationMin: z.number().int().min(5).max(600).nullable().optional(),
  })
  .strict();

export const serviceDetailsSchema = z
  .record(z.string().max(120), serviceDetailSchema)
  .refine((v) => Object.keys(v).length <= 60, "Too many services");

export const pageDesignFields = {
  pageTemplate: z.enum(BOOKING_TEMPLATES).optional(),
  pageStyle: pageStyleSchema.optional(),
  coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable().optional(),
  heroTitle: z.string().trim().max(80).optional(),
  heroSubtitle: z.string().trim().max(200).optional(),
  serviceDetails: serviceDetailsSchema.optional(),
};

// تعديل أخصائي/مكان: الاسم واللقب والصورة
export const updateResourceSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    title: z.string().trim().max(60).nullable().optional(),
    photoDataUrl: imageDataUrl(THUMB_MAX_CHARS, "The photo").nullable().optional(),
  })
  .strict();

// تفاصيل الخدمات اللي اتمسحت من قائمة الخدمات مالهاش لازمة
export function keepKnownServices<T>(details: Record<string, T>, services: string[]): Record<string, T> {
  const known = new Set(services);
  return Object.fromEntries(Object.entries(details).filter(([name]) => known.has(name)));
}
