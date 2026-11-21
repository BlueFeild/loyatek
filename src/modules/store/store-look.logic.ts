import { z } from "zod";

// شكل المتجر (زي الموقع التعريفي وقوالب الحجز): قالب جاهز + خط + شكل الكروت + أعمدة + زراير + شريط إعلان
// + أقسام الصفحة الرئيسية (تشغيل/إيقاف + ترتيب) + آراء العملاء. القوايم دي لازم تطابق
// frontend/src/pages/store/storeLook.ts

export const STORE_TEMPLATES = ["clean", "boutique", "bold", "soft", "luxe", "fresh"] as const;
export const STORE_FONTS = ["modern", "elegant", "rounded", "classic", "bold"] as const;
export const CARD_STYLES = ["minimal", "bordered", "shadow", "overlay"] as const;
export const BUTTON_SHAPES = ["pill", "rounded", "square"] as const;
export const IMAGE_RATIOS = ["square", "portrait", "landscape"] as const;
export const HERO_STYLES = ["cover", "split", "slides", "minimal"] as const;
export const HOME_SECTIONS = ["hero", "featured", "categories", "new", "sale", "about", "testimonials", "contact"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

export interface StoreLook {
  font: (typeof STORE_FONTS)[number];
  cardStyle: (typeof CARD_STYLES)[number];
  columns: 2 | 3 | 4 | 5;
  mobileColumns: 1 | 2;
  buttonShape: (typeof BUTTON_SHAPES)[number];
  imageRatio: (typeof IMAGE_RATIOS)[number];
  heroStyle: (typeof HERO_STYLES)[number];
  announcement: { on: boolean; text: string; link: string | null };
  sections: { id: HomeSection; on: boolean }[];
  testimonials: { name: string; text: string }[];
  showSecondPhoto: boolean;
}

// كل قالب = قيم أولية للشكل (التاجر يقدر يغيّر أي حاجة بعد كده)
export const TEMPLATE_DEFAULTS: Record<(typeof STORE_TEMPLATES)[number], Pick<StoreLook, "font" | "cardStyle" | "buttonShape" | "imageRatio" | "heroStyle">> = {
  clean: { font: "modern", cardStyle: "minimal", buttonShape: "pill", imageRatio: "portrait", heroStyle: "cover" },
  boutique: { font: "elegant", cardStyle: "minimal", buttonShape: "square", imageRatio: "portrait", heroStyle: "split" },
  bold: { font: "bold", cardStyle: "bordered", buttonShape: "square", imageRatio: "square", heroStyle: "cover" },
  soft: { font: "rounded", cardStyle: "shadow", buttonShape: "pill", imageRatio: "square", heroStyle: "minimal" },
  luxe: { font: "classic", cardStyle: "overlay", buttonShape: "rounded", imageRatio: "portrait", heroStyle: "slides" },
  fresh: { font: "rounded", cardStyle: "bordered", buttonShape: "rounded", imageRatio: "landscape", heroStyle: "split" },
};

export const DEFAULT_SECTIONS: StoreLook["sections"] = [
  { id: "hero", on: true },
  { id: "featured", on: true },
  { id: "categories", on: true },
  { id: "new", on: true },
  { id: "sale", on: true },
  { id: "about", on: true },
  { id: "testimonials", on: false },
  { id: "contact", on: true },
];

export function defaultLook(template: string): StoreLook {
  const t = TEMPLATE_DEFAULTS[(STORE_TEMPLATES as readonly string[]).includes(template) ? (template as keyof typeof TEMPLATE_DEFAULTS) : "clean"];
  return { ...t, columns: 4, mobileColumns: 2, announcement: { on: false, text: "", link: null }, sections: DEFAULT_SECTIONS.map((s) => ({ ...s })), testimonials: [], showSecondPhoto: true };
}

const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !v || /^https:\/\//i.test(v) || /^\/[\w\-/?=&%.]*$/.test(v), "Use a link that starts with https:// or a page of your shop")
  .nullable()
  .optional();

export const lookInput = z
  .object({
    template: z.enum(STORE_TEMPLATES).optional(),
    font: z.enum(STORE_FONTS).optional(),
    cardStyle: z.enum(CARD_STYLES).optional(),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    mobileColumns: z.union([z.literal(1), z.literal(2)]).optional(),
    buttonShape: z.enum(BUTTON_SHAPES).optional(),
    imageRatio: z.enum(IMAGE_RATIOS).optional(),
    heroStyle: z.enum(HERO_STYLES).optional(),
    showSecondPhoto: z.boolean().optional(),
    announcement: z.object({ on: z.boolean(), text: z.string().trim().max(140), link }).optional(),
    sections: z
      .array(z.object({ id: z.enum(HOME_SECTIONS), on: z.boolean() }))
      .max(HOME_SECTIONS.length)
      .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "Each section can be there once")
      .optional(),
    testimonials: z.array(z.object({ name: z.string().trim().min(1, "Add the customer's name").max(60), text: z.string().trim().min(1, "Write what they said").max(300) })).max(8, "Up to 8 reviews").optional(),
    // لو اختار قالب: نرجّع قيمه الأولية (خط/كروت/...) إلا لو بعت قيمة بنفسه
    applyTemplate: z.boolean().optional(),
  })
  .strict();

// القراية من الداتابيز بأمان: أي حاجة ناقصة/غلط = القيمة الأولية
export function readLook(raw: unknown, template: string): StoreLook {
  const base = defaultLook(template);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : d);
  const sections = Array.isArray(r.sections)
    ? (r.sections as unknown[]).filter((s): s is { id: HomeSection; on: boolean } => !!s && typeof s === "object" && (HOME_SECTIONS as readonly unknown[]).includes((s as { id: unknown }).id)).map((s) => ({ id: s.id, on: s.on !== false }))
    : base.sections;
  // أقسام جديدة اتضافت بعدين = في الآخر (مقفولة)
  for (const id of HOME_SECTIONS) if (!sections.some((s) => s.id === id)) sections.push({ id, on: false });
  const ann = (r.announcement && typeof r.announcement === "object" ? r.announcement : {}) as Record<string, unknown>;
  return {
    font: pick(r.font, STORE_FONTS, base.font),
    cardStyle: pick(r.cardStyle, CARD_STYLES, base.cardStyle),
    columns: ([2, 3, 4, 5] as const).includes(r.columns as 2) ? (r.columns as StoreLook["columns"]) : base.columns,
    mobileColumns: r.mobileColumns === 1 ? 1 : 2,
    buttonShape: pick(r.buttonShape, BUTTON_SHAPES, base.buttonShape),
    imageRatio: pick(r.imageRatio, IMAGE_RATIOS, base.imageRatio),
    heroStyle: pick(r.heroStyle, HERO_STYLES, base.heroStyle),
    showSecondPhoto: r.showSecondPhoto !== false,
    announcement: { on: ann.on === true, text: typeof ann.text === "string" ? ann.text.slice(0, 140) : "", link: typeof ann.link === "string" && ann.link ? ann.link : null },
    sections,
    testimonials: Array.isArray(r.testimonials)
      ? (r.testimonials as unknown[])
          .filter((t): t is { name: string; text: string } => !!t && typeof (t as { name?: unknown }).name === "string" && typeof (t as { text?: unknown }).text === "string")
          .slice(0, 8)
          .map((t) => ({ name: t.name, text: t.text }))
      : [],
  };
}

export function mergeLook(current: StoreLook, template: string, input: z.infer<typeof lookInput>): StoreLook {
  const { template: _t, applyTemplate, ...rest } = input;
  void _t;
  let next = { ...current };
  if (applyTemplate && input.template) next = { ...next, ...TEMPLATE_DEFAULTS[input.template] };
  next = { ...next, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as StoreLook;
  if (input.announcement) next.announcement = { on: input.announcement.on, text: input.announcement.text, link: input.announcement.link || null };
  if (input.sections) {
    const list = [...input.sections];
    for (const id of HOME_SECTIONS) if (!list.some((s) => s.id === id)) list.push({ id, on: false });
    next.sections = list;
  }
  return readLook(next, template);
}
