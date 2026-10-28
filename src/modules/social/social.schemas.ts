import { z } from "zod";
import { SOCIAL_LIMITS } from "./social-types";

// شكل البيانات اللي جاية من الشاشة (الـ controller بيتأكد منها قبل الخدمة)

export const connectMetaSchema = z.union([z.object({ code: z.string().min(4).max(2000) }), z.object({ accessToken: z.string().min(10).max(2000) })]);

export const postInputSchema = z
  .object({
    caption: z.string().max(SOCIAL_LIMITS.captionMax).default(""),
    mediaId: z.string().uuid().nullable().default(null),
    accountIds: z.array(z.string().uuid()).min(1, "Choose at least one account").max(20),
    // now = انشر دلوقتي، schedule = في ميعاد، draft = احفظ بس
    when: z.enum(["now", "schedule", "draft"]),
    scheduledAt: z.coerce.date().optional(),
  })
  .refine((v) => v.when !== "schedule" || v.scheduledAt, { message: "Pick the date and time to publish", path: ["scheduledAt"] });

export type PostInput = z.infer<typeof postInputSchema>;

export const listPostsSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const uploadMediaSchema = z.object({ mimeType: z.string().min(3).max(100) });
