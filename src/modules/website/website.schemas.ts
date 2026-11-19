import { z } from "zod";
import { imageDataUrl } from "../booking/page-design";

// الموقع التعريفي: التحقق من المدخلات + ترتيب الأقسام (منطق خالص بيتختبر لوحده)

// لازم تفضل نفس القائمة اللي في الفرونت (frontend/src/pages/website/websiteTypes.ts)
export const WEBSITE_TEMPLATES = ["bluefield", "mint", "blush", "sky", "sand", "lavender", "ocean", "mono"] as const;
export const WEBSITE_FONTS = ["modern", "elegant", "rounded"] as const;
export const WEBSITE_LANGUAGES = ["en", "ar"] as const;

// الأقسام بالترتيب الافتراضي. hero دايمًا أول واحد ودايمًا ظاهر
export const SECTION_IDS = ["hero", "about", "services", "gallery", "team", "stats", "testimonials", "faq", "hours", "contact"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
// اللي بيبقى ظاهر في موقع جديد (الباقي التاجر يفتحه لما يملاه)
const DEFAULT_ON: SectionId[] = ["hero", "about", "services", "gallery", "contact"];

export const PHOTO_KINDS = ["gallery", "about", "team", "service"] as const;
export const LIMITS = {
  heroButtons: 2,
  services: 24,
  gallery: 30,
  team: 20,
  stats: 4,
  testimonials: 12,
  faq: 20,
  // كل الصور المرفوعة للشركة (المعرض + الفريق + الخدمات + من نحن)
  photosTotal: 90,
} as const;
export const PHOTO_MAX_CHARS = 2_100_000; // ~1.5 MB صورة فعلية (الفرونت بيصغّرها)
export const LOGO_MAX_CHARS = 700_000;
export const COVER_MAX_CHARS = 2_500_000;

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #0ea5e9");
const text = (max: number) => z.string().max(max, `Please keep it under ${max} characters`).transform((v) => v.trim());
const photoId = z.string().uuid().nullable().default(null);
// id قصير بيعمله الفرونت لكل عنصر (عشان التعديل والترتيب)
const itemId = z.string().max(40).regex(/^[A-Za-z0-9_-]*$/).default("");

// لينك https بس (أو فاضي)
export const httpsUrl = (max = 500) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .refine((v) => v === "" || /^https:\/\/[^\s<>"']+$/i.test(v), "Links must start with https://")
    .default("");

// أرقام بس مع كود الدولة (974...)
const phoneDigits = z
  .string()
  .max(30)
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v === "" || (v.length >= 7 && v.length <= 15), "Please write a full phone number with the country code")
  .default("");
const email = z
  .string()
  .max(160)
  .transform((v) => v.trim())
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Please write a valid email")
  .default("");

export const HERO_BUTTON_KINDS = ["call", "whatsapp", "book", "menu", "shop", "link"] as const;

const heroSchema = z
  .object({
    title: text(120).default(""),
    subtitle: text(300).default(""),
    buttons: z
      .array(z.object({ kind: z.enum(HERO_BUTTON_KINDS), label: text(30).default(""), url: httpsUrl() }).strict())
      .max(LIMITS.heroButtons, `Up to ${LIMITS.heroButtons} buttons`)
      .default([]),
    // خلفية الكارت الكبير: صورة الغلاف / تدرّج من اللون الأساسي / لون سادة
    background: z.enum(["photo", "gradient", "color"]).default("gradient"),
  })
  .strict()
  .default({});

const contentSchemaRaw = z
  .object({
    sections: z.array(z.object({ id: z.enum(SECTION_IDS), on: z.boolean() }).strict()).max(20).default([]),
    hero: heroSchema,
    about: z.object({ heading: text(80).default(""), text: text(3000).default(""), photoId }).strict().default({}),
    services: z
      .object({
        heading: text(80).default(""),
        intro: text(300).default(""),
        items: z
          .array(
            z
              .object({
                id: itemId,
                title: text(80).refine((v) => v.length > 0, "Each service needs a name"),
                text: text(400).default(""),
                // بالدولار (زي كل الفلوس)؛ null = من غير سعر
                price: z.number().min(0, "Prices can't be negative").max(1e9).nullable().default(null),
                photoId,
              })
              .strict()
          )
          .max(LIMITS.services, `Up to ${LIMITS.services} services`)
          .default([]),
      })
      .strict()
      .default({}),
    gallery: z
      .object({
        heading: text(80).default(""),
        photoIds: z.array(z.string().uuid()).max(LIMITS.gallery, `Up to ${LIMITS.gallery} photos in the gallery`).default([]),
      })
      .strict()
      .default({}),
    team: z
      .object({
        heading: text(80).default(""),
        members: z
          .array(z.object({ id: itemId, name: text(80).refine((v) => v.length > 0, "Each person needs a name"), role: text(80).default(""), photoId }).strict())
          .max(LIMITS.team, `Up to ${LIMITS.team} people`)
          .default([]),
      })
      .strict()
      .default({}),
    stats: z
      .object({
        items: z
          .array(z.object({ id: itemId, value: text(20).refine((v) => v.length > 0, "Write the number, e.g. 10+"), label: text(60).default("") }).strict())
          .max(LIMITS.stats, `Up to ${LIMITS.stats} numbers`)
          .default([]),
      })
      .strict()
      .default({}),
    testimonials: z
      .object({
        heading: text(80).default(""),
        items: z
          .array(
            z
              .object({
                id: itemId,
                name: text(80).refine((v) => v.length > 0, "Each review needs a name"),
                text: text(600).refine((v) => v.length > 0, "Write what the customer said"),
                stars: z.number().int().min(1).max(5).default(5),
              })
              .strict()
          )
          .max(LIMITS.testimonials, `Up to ${LIMITS.testimonials} reviews`)
          .default([]),
      })
      .strict()
      .default({}),
    faq: z
      .object({
        heading: text(80).default(""),
        items: z
          .array(z.object({ id: itemId, q: text(200).refine((v) => v.length > 0, "Write the question"), a: text(1500).default("") }).strict())
          .max(LIMITS.faq, `Up to ${LIMITS.faq} questions`)
          .default([]),
      })
      .strict()
      .default({}),
    // 7 أيام من الأحد للسبت؛ نص حر زي "9:00 – 18:00"؛ فاضي = مقفول
    hours: z
      .object({
        heading: text(80).default(""),
        days: z.array(text(60)).length(7).default(["", "", "", "", "", "", ""]),
        note: text(200).default(""),
      })
      .strict()
      .default({}),
    contact: z
      .object({
        heading: text(80).default(""),
        phone: phoneDigits,
        whatsapp: phoneDigits,
        email,
        address: text(300).default(""),
        mapUrl: httpsUrl(1000),
        form: z.boolean().default(true),
      })
      .strict()
      .default({}),
    social: z
      .object({
        instagram: httpsUrl(300),
        facebook: httpsUrl(300),
        tiktok: httpsUrl(300),
        x: httpsUrl(300),
        snapchat: httpsUrl(300),
        youtube: httpsUrl(300),
        linkedin: httpsUrl(300),
      })
      .strict()
      .default({}),
    floatingWhatsapp: z.boolean().default(true),
    // أزرار لصفحات الشركة التانية على BlueField (الحجز، المنيو، المتجر...)
    otherPages: z.boolean().default(true),
  })
  .strict();

export type WebsiteContent = z.infer<typeof contentSchemaRaw>;

// ترتيب الأقسام: كل قسم مرة واحدة بالظبط، hero أول واحد وظاهر، أي قسم ناقص بيتضاف في الآخر
export function normalizeSections(list: { id: string; on: boolean }[] | null | undefined): { id: SectionId; on: boolean }[] {
  const seen = new Set<string>();
  const out: { id: SectionId; on: boolean }[] = [];
  for (const s of list ?? []) {
    if (!(SECTION_IDS as readonly string[]).includes(s.id) || seen.has(s.id) || s.id === "hero") continue;
    seen.add(s.id);
    out.push({ id: s.id as SectionId, on: !!s.on });
  }
  const isNew = out.length === 0;
  for (const id of SECTION_IDS) {
    if (id === "hero" || seen.has(id)) continue;
    out.push({ id, on: isNew ? DEFAULT_ON.includes(id) : false });
  }
  return [{ id: "hero", on: true }, ...out];
}

// تكرار الصور في المعرض ممنوع + ids العناصر الفاضية بتتملى
export const contentSchema = contentSchemaRaw.transform((c) => {
  let n = 0;
  const fill = <T extends { id: string }>(items: T[], prefix: string) => items.map((it) => (it.id ? it : { ...it, id: `${prefix}${++n}` }));
  return {
    ...c,
    sections: normalizeSections(c.sections),
    gallery: { ...c.gallery, photoIds: Array.from(new Set(c.gallery.photoIds)) },
    services: { ...c.services, items: fill(c.services.items, "s") },
    team: { ...c.team, members: fill(c.team.members, "t") },
    stats: { items: fill(c.stats.items, "n") },
    testimonials: { ...c.testimonials, items: fill(c.testimonials.items, "r") },
    faq: { ...c.faq, items: fill(c.faq.items, "q") },
  };
});

// محتوى قديم/فاضي من الداتابيز -> محتوى كامل بالقيم الافتراضية (من غير ما يقع لو فيه حاجة غلط)
export function readContent(raw: unknown): WebsiteContent {
  const r = contentSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  return contentSchema.parse({});
}

// كل الصور اللي المحتوى بيستخدمها
export function referencedPhotoIds(c: WebsiteContent): string[] {
  const ids = new Set<string>(c.gallery.photoIds);
  if (c.about.photoId) ids.add(c.about.photoId);
  for (const s of c.services.items) if (s.photoId) ids.add(s.photoId);
  for (const m of c.team.members) if (m.photoId) ids.add(m.photoId);
  return [...ids];
}

// أي صورة مش بتاعة الشركة (أو اتمسحت) بتتشال من المحتوى
export function keepKnownPhotos(c: WebsiteContent, known: Set<string>): WebsiteContent {
  const ok = (id: string | null) => (id && known.has(id) ? id : null);
  return {
    ...c,
    about: { ...c.about, photoId: ok(c.about.photoId) },
    gallery: { ...c.gallery, photoIds: c.gallery.photoIds.filter((id) => known.has(id)) },
    services: { ...c.services, items: c.services.items.map((s) => ({ ...s, photoId: ok(s.photoId) })) },
    team: { ...c.team, members: c.team.members.map((m) => ({ ...m, photoId: ok(m.photoId) })) },
  };
}

export const pageStyleSchema = z
  .object({
    accent: HEX.nullable().optional(),
    font: z.enum(WEBSITE_FONTS).optional(),
  })
  .strict();

const optText = (max: number) =>
  z
    .string()
    .max(max, `Please keep it under ${max} characters`)
    .transform((v) => v.trim() || null)
    .nullable();

export const settingsSchema = z
  .object({
    published: z.boolean(),
    template: z.enum(WEBSITE_TEMPLATES),
    pageStyle: pageStyleSchema,
    brandName: optText(80),
    logoDataUrl: imageDataUrl(LOGO_MAX_CHARS, "The logo").nullable(),
    coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable(),
    seoTitle: optText(70),
    seoDescription: optText(170),
    language: z.enum(WEBSITE_LANGUAGES),
  })
  .partial()
  .strict();
export type SettingsInput = z.infer<typeof settingsSchema>;

export const photoSchema = z.object({ kind: z.enum(PHOTO_KINDS).default("gallery"), dataUrl: imageDataUrl(PHOTO_MAX_CHARS, "The photo") }).strict();
export const inquiryStatusSchema = z.object({ status: z.enum(["NEW", "READ"]) }).strict();

// رسالة من فورم "تواصل معنا". website = فخ للروبوتات (مخفي عن البشر)
export const publicInquirySchema = z
  .object({
    name: z.string().trim().min(2, "Please write your name").max(100),
    phone: z
      .string()
      .max(30)
      .transform((v) => v.replace(/[^\d+]/g, ""))
      .refine((v) => v === "" || /^\+?\d{7,15}$/.test(v), "Please write a valid phone number")
      .default(""),
    email: z
      .string()
      .max(160)
      .transform((v) => v.trim())
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Please write a valid email")
      .default(""),
    message: z.string().trim().min(2, "Please write your message").max(2000),
    website: z.string().max(200).optional(),
  })
  .refine((v) => v.phone !== "" || v.email !== "", { message: "Please write your phone number or email so they can reply", path: ["phone"] });

// data URL -> بايتات الصورة (PNG/JPEG/WebP بس)
export function decodeImageDataUrl(dataUrl: string | null | undefined): { mime: string; bytes: Buffer } | null {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

// اليوم بتوقيت UTC (عداد الزيارات)
export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
export function lastDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(dayKey(new Date(now.getTime() - i * 86_400_000)));
  return out;
}
