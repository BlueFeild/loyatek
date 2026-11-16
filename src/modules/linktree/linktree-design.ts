import { z } from "zod";
import { imageDataUrl, COVER_MAX_CHARS } from "../booking/page-design";

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #14B8A6");

// الأشكال الجاهزة لصفحة Link-in-Bio - لازم تطابق frontend/src/data/linktreeTemplates.ts
export const LINKTREE_TEMPLATES = [
  "arch", "editorial", "olive", "studio", "champagne", "terracotta",
  "classic", "sky", "sunset", "ocean", "aurora", "mint", "candy", "noir",
  "paper", "neon", "lavender", "desert", "forest", "citrus", "rose",
] as const;

export const linktreePageStyleSchema = z
  .object({
    shape: z.enum(["pill", "rounded", "square"]).optional(),
    font: z.enum(["modern", "elegant", "rounded", "bold", "luxe"]).optional(),
    // أول لينك يبان أكبر وملوّن (للعرض أو الحجز)
    featured: z.boolean().optional(),
    // لينكات السوشيال تبان أيقونات صغيرة تحت الاسم بدل أزرار
    socialRow: z.boolean().optional(),
    // banner = كارت فوق / hero = الصورة بعرض الصفحة وبتدوب في الخلفية
    coverStyle: z.enum(["banner", "hero"]).optional(),
    animate: z.boolean().optional(),
    // خلفية التاجر بدل خلفية الشكل: لون / تدرّج (ممكن يتحرك) / صورة (بتغميق ولون فوقها)
    bg: z
      .object({
        type: z.enum(["color", "gradient", "photo"]),
        color: HEX.optional(),
        color2: HEX.optional(),
        moving: z.boolean().optional(),
        dim: z.number().int().min(0).max(85).optional(),
        tint: HEX.optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const linktreeDesignFields = {
  pageTemplate: z.enum(LINKTREE_TEMPLATES).optional(),
  pageStyle: linktreePageStyleSchema.nullable().optional(),
  coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable().optional(),
  backgroundDataUrl: imageDataUrl(COVER_MAX_CHARS, "The background photo").nullable().optional(),
};
