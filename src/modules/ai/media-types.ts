import { z } from "zod";
import { ServiceUnavailableError } from "../../core/errors";
import type { BusinessContext } from "./copy-generator";

// "عقود" أدوات الصور والفيديو والتحليل: أي مزوّد بيطبّقها، والخدمات مابتعرفش مين

const MAX_IMAGE_BASE64 = 6_000_000; // ~4.5MB صورة (الشاشة بتصغّرها قبل الرفع)

export const inputImageSchema = z.object({
  base64: z.string().min(20).max(MAX_IMAGE_BASE64, "The photo is too large — please use a smaller one"),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
export type InputImage = z.infer<typeof inputImageSchema>;

// ---------- الصور ----------
export const IMAGE_SCENES = ["none", "studio", "lusail", "souq_waqif", "majlis", "corniche", "desert", "pearl", "flat_lay"] as const;
export const IMAGE_STYLES = ["photo", "luxury", "minimal", "vibrant", "illustration"] as const;
export const IMAGE_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;

export const imageBriefSchema = z.object({
  prompt: z.string().trim().min(3, "Describe the image you want").max(1000),
  scene: z.enum(IMAGE_SCENES).default("none"),
  style: z.enum(IMAGE_STYLES).default("photo"),
  aspectRatio: z.enum(IMAGE_RATIOS).default("1:1"),
  // صورة المنتج (اختياري): بنشيل خلفيتها ونحطها في المشهد
  productImage: inputImageSchema.optional(),
});
export type ImageBrief = z.infer<typeof imageBriefSchema>;

export interface GeneratedMedia {
  base64: string;
  mimeType: string;
}

export interface ImageGenerator {
  readonly model: string;
  generate(brief: ImageBrief, business: BusinessContext): Promise<GeneratedMedia>;
}

// ---------- الفيديو ----------
export const VIDEO_RATIOS = ["9:16", "16:9"] as const;

export const videoBriefSchema = z.object({
  prompt: z.string().trim().min(3, "Describe the video you want").max(1000),
  aspectRatio: z.enum(VIDEO_RATIOS).default("9:16"),
  // تحريك صورة: صورة من الجهاز أو صورة عملها استوديو الصور قبل كده
  sourceImage: inputImageSchema.optional(),
  sourceAssetId: z.string().uuid().optional(),
});
export type VideoBrief = z.infer<typeof videoBriefSchema>;

export interface VideoGenerator {
  readonly model: string;
  generate(brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage }, business: BusinessContext): Promise<GeneratedMedia>;
}

// ---------- تحليل الحسابات ----------
export const AUDIT_PLATFORMS = ["instagram", "tiktok", "snapchat", "x", "facebook"] as const;

const count = z.number().int().min(0).max(1_000_000_000).optional();

export const auditInputSchema = z.object({
  platform: z.enum(AUDIT_PLATFORMS),
  handle: z.string().trim().min(1, "Write the account name").max(80),
  niche: z.string().trim().max(120).optional(),
  goal: z.string().trim().max(300).optional(),
  followers: count,
  following: count,
  postsPerWeek: z.number().min(0).max(200).optional(),
  avgLikes: count,
  avgComments: count,
  avgViews: count,
  // سكرين شوت من البروفايل والإحصائيات (Insights) - لحد 4
  screenshots: z.array(inputImageSchema).max(4).default([]),
});
export type AuditInput = z.infer<typeof auditInputSchema>;

export const auditReportSchema = z.object({
  healthScore: z.number().min(0).max(100),
  summary: z.string(),
  engagementVerdict: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  opportunities: z.array(z.string()),
  threats: z.array(z.string()),
  quickWins: z.array(z.string()),
  contentPlan: z.array(z.object({ pillar: z.string(), idea: z.string() })),
  postingSchedule: z.string(),
  adPlan: z.object({
    objective: z.string(),
    audience: z.string(),
    dailyBudgetQar: z.number().min(0),
    durationDays: z.number().int().min(1).max(90),
    creativeIdea: z.string(),
  }),
});
export type AuditReport = z.infer<typeof auditReportSchema>;

// رد المزوّد (نص JSON) ← تقرير متأكدين من شكله
export function parseAuditReport(text: string | undefined): AuditReport {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    throw new ServiceUnavailableError("The AI returned an unexpected answer — please try again.");
  }
  const parsed = auditReportSchema.safeParse(json);
  if (!parsed.success) throw new ServiceUnavailableError("The AI returned an unexpected answer — please try again.");
  return { ...parsed.data, healthScore: Math.round(parsed.data.healthScore) };
}

export interface AccountAuditor {
  readonly model: string;
  audit(input: AuditInput, metrics: AuditMetrics, business: BusinessContext): Promise<AuditReport>;
}

// أرقام بنحسبها احنا (مش الذكاء الاصطناعي) عشان تبقى دقيقة
export type AuditMetrics = {
  engagementRate: number | null; // ٪ = (لايكات + كومنتات) ÷ المتابعين
  viewRate: number | null; // ٪ = المشاهدات ÷ المتابعين
};

export function computeAuditMetrics(input: AuditInput): AuditMetrics {
  const f = input.followers ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  const interactions = (input.avgLikes ?? 0) + (input.avgComments ?? 0);
  return {
    engagementRate: f > 0 && (input.avgLikes !== undefined || input.avgComments !== undefined) ? round((interactions / f) * 100) : null,
    viewRate: f > 0 && input.avgViews !== undefined ? round((input.avgViews / f) * 100) : null,
  };
}

// JSON Schema لشكل التقرير (بيتبعت للمزوّد) - لازم يطابق auditReportSchema
const strings = { type: "array", items: { type: "string" } };
export const AUDIT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    healthScore: { type: "number" },
    summary: { type: "string" },
    engagementVerdict: { type: "string" },
    strengths: strings,
    weaknesses: strings,
    opportunities: strings,
    threats: strings,
    quickWins: strings,
    contentPlan: {
      type: "array",
      items: { type: "object", properties: { pillar: { type: "string" }, idea: { type: "string" } }, required: ["pillar", "idea"], additionalProperties: false },
    },
    postingSchedule: { type: "string" },
    adPlan: {
      type: "object",
      properties: {
        objective: { type: "string" },
        audience: { type: "string" },
        dailyBudgetQar: { type: "number" },
        durationDays: { type: "integer" },
        creativeIdea: { type: "string" },
      },
      required: ["objective", "audience", "dailyBudgetQar", "durationDays", "creativeIdea"],
      additionalProperties: false,
    },
  },
  required: [
    "healthScore",
    "summary",
    "engagementVerdict",
    "strengths",
    "weaknesses",
    "opportunities",
    "threats",
    "quickWins",
    "contentPlan",
    "postingSchedule",
    "adPlan",
  ],
  additionalProperties: false,
};
