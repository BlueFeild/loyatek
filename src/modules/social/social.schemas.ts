import { z } from "zod";
import { SOCIAL_LIMITS } from "./social-types";
import { AD_GENDERS, AD_LIMITS, AD_OBJECTIVES } from "./ads-types";

// شكل البيانات اللي جاية من الشاشة (الـ controller بيتأكد منها قبل الخدمة)

export const connectMetaSchema = z.union([z.object({ code: z.string().min(4).max(2000) }), z.object({ accessToken: z.string().min(10).max(2000) })]);

// إعدادات تيك توك (لازم التاجر يختار مين يشوف البوست بنفسه)
export const tiktokOptionsSchema = z.object({
  privacyLevel: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]),
  allowComment: z.boolean().default(false),
  allowDuet: z.boolean().default(false),
  allowStitch: z.boolean().default(false),
  brandOrganic: z.boolean().default(false),
  brandedContent: z.boolean().default(false),
});

export const postInputSchema = z
  .object({
    caption: z.string().max(SOCIAL_LIMITS.captionMax).default(""),
    mediaId: z.string().uuid().nullable().default(null),
    accountIds: z.array(z.string().uuid()).min(1, "Choose at least one account").max(20),
    // now = انشر دلوقتي، schedule = في ميعاد، draft = احفظ بس
    when: z.enum(["now", "schedule", "draft"]),
    scheduledAt: z.coerce.date().optional(),
    options: z.object({ tiktok: tiktokOptionsSchema.optional() }).optional(),
  })
  .refine((v) => v.when !== "schedule" || v.scheduledAt, { message: "Pick the date and time to publish", path: ["scheduledAt"] });

export type PostInput = z.infer<typeof postInputSchema>;

export const listPostsSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const uploadMediaSchema = z.object({ mimeType: z.string().min(3).max(100) });

// ---------- صندوق التعليقات والرسايل ----------
export const threadRefSchema = z.object({
  accountId: z.string().uuid(),
  kind: z.enum(["COMMENT", "DM"]),
  threadKey: z.string().min(1).max(200),
});

export const threadListSchema = z.object({
  kind: z.enum(["COMMENT", "DM"]).optional(),
  accountId: z.string().uuid().optional(),
});

export const replySchema = threadRefSchema.extend({ text: z.string().trim().min(1, "Write the reply first").max(2000) });

export const suggestSchema = threadRefSchema.extend({ dialect: z.enum(["qatari", "gulf", "msa", "egyptian", "english"]).optional() });

// ---------- الإعلانات المدفوعة (تمويل بوست) ----------
export const adTargetingSchema = z
  .object({
    countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(AD_LIMITS.maxCountries).default([]),
    cities: z.array(z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(120) })).max(AD_LIMITS.maxCities).default([]),
    ageMin: z.number().int().min(AD_LIMITS.ageMin).max(AD_LIMITS.ageMax).default(18),
    ageMax: z.number().int().min(AD_LIMITS.ageMin).max(AD_LIMITS.ageMax).default(65),
    gender: z.enum(AD_GENDERS).default("all"),
  })
  .transform((t) => ({ ...t, countries: t.countries.map((c) => c.toUpperCase()) }))
  .refine((t) => t.countries.length > 0 || t.cities.length > 0, { message: "Choose at least one country or city", path: ["countries"] })
  .refine((t) => t.ageMin <= t.ageMax, { message: "The minimum age must be less than the maximum", path: ["ageMin"] });

export const boostSchema = z.object({
  targetId: z.string().uuid(),
  adAccountId: z.string().regex(/^act_\d{1,30}$/, "Choose an ad account"),
  objective: z.enum(AD_OBJECTIVES),
  dailyBudget: z.number().positive("Enter the daily budget").max(1_000_000),
  days: z.number().int().min(1).max(365),
  startAt: z.coerce.date().optional(),
  targeting: adTargetingSchema,
  confirmedTotal: z.number().positive(),
});

export const adBudgetSchema = z.object({ dailyBudget: z.number().positive("Enter the daily budget").max(1_000_000) });

export const citySearchSchema = z.object({ q: z.string().trim().min(2, "Type at least 2 letters").max(60) });
