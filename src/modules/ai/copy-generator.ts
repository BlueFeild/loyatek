import { z } from "zod";

// "عقد" مولّد النصوص: أي مزوّد (Claude أو غيره) بيطبّقه، والخدمة مابتعرفش مين
export const COPY_KINDS = ["caption", "ad", "product", "hashtags", "sms", "whatsapp"] as const;
export const DIALECTS = ["qatari", "gulf", "msa", "egyptian", "english"] as const;
export const TONES = ["friendly", "luxury", "playful", "professional", "urgent"] as const;
export const PLATFORMS = ["instagram", "tiktok", "snapchat", "x", "facebook", "any"] as const;

export type CopyKind = (typeof COPY_KINDS)[number];
export type Dialect = (typeof DIALECTS)[number];

export const copyBriefSchema = z.object({
  kind: z.enum(COPY_KINDS),
  dialect: z.enum(DIALECTS).default("qatari"),
  tone: z.enum(TONES).default("friendly"),
  platform: z.enum(PLATFORMS).default("instagram"),
  topic: z.string().trim().min(2, "Write what the post is about").max(200),
  details: z.string().trim().max(1500).optional(),
  variants: z.number().int().min(1).max(3).default(3),
});
export type CopyBrief = z.infer<typeof copyBriefSchema>;

export interface BusinessContext {
  name: string;
  industry: string;
}

export const copyResultSchema = z.object({
  variants: z.array(z.object({ text: z.string().min(1), hashtags: z.array(z.string()) })).min(1),
});
export type CopyResult = z.infer<typeof copyResultSchema>;

export interface CopyGenerator {
  readonly model: string;
  generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult>;
}
