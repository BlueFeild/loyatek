import { z } from "zod";

// "اسأل BlueField" - المساعد الذكي على الموقع العام (للزوار، من غير تسجيل دخول ومن غير نقاط).
// أي مزوّد (Gemini / Claude / Fake) بيطبّق SiteAssistantModel، والخدمة مابتعرفش مين.

export const SITE_ASSISTANT_LIMITS = {
  maxTurns: 12, // آخر 12 رسالة بس بتروح للمزوّد
  maxIncomingTurns: 30, // أكتر من كده = طلب غلط
  maxChars: 1000, // كل رسالة
  maxReplyChars: 1500,
  maxSuggestions: 3,
  maxLinks: 3,
  timeoutMs: 25_000,
};

export type SiteLang = "en" | "ar";

export interface SiteChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SiteLink {
  path: string;
  label: string;
}

export interface SiteAnswer {
  reply: string;
  suggestions: string[];
  links: SiteLink[];
}

export interface SiteAssistantInput {
  system: string;
  messages: SiteChatTurn[];
}

export interface SiteAssistantModel {
  readonly model: string;
  reply(input: SiteAssistantInput): Promise<SiteAnswer>;
}

// الحقايق اللي بتتقري لايف كل مرة (مش من دماغ الموديل)
export interface SiteFacts {
  country: string | null;
  currency: string;
  // سعر الخدمة الشهري بعملة الزائر بعد أي خصم شغال
  monthly: Record<string, number>;
  // السعر قبل الخصم (لو فيه خصم)
  original: Record<string, number>;
  discounts: Record<string, { pct: number; endsAt: string | null }>;
  yearlyDiscountPct: number;
  extraCompanyPrice: number;
  trialDays: number;
  aiMonthlyCredits: number;
  smsMonthlyIncluded: number;
}

export interface SiteFactsSource {
  facts(country: string | null): Promise<SiteFacts>;
}

// اللينكات المسموحة بس (الموديل ممكن يقترح، والسيرفر بيفلتر)
export const SERVICE_PAGES: Record<string, string> = {
  booking: "booking",
  catalog: "menu",
  whatsapp: "whatsapp",
  wallet: "wallet",
  erp: "erp",
  linktree: "link-in-bio",
  ai: "ai-studio",
  social: "social",
  walogin: "whatsapp-login",
  tickets: "tickets",
  store: "store",
  properties: "properties",
  sms: "sms",
  website: "informative-website",
};

export const ALLOWED_PATHS = new Set<string>([
  "/pricing",
  "/solutions",
  "/contact",
  "/signup",
  "/about",
  ...Object.values(SERVICE_PAGES).map((s) => `/solutions/${s}`),
  // صفحتين جوه الإعلانات والتحليل (جزء من السوشيال)
  "/solutions/ads",
  "/solutions/audit",
]);

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1, "Write a message first.").max(SITE_ASSISTANT_LIMITS.maxChars, `Keep each message under ${SITE_ASSISTANT_LIMITS.maxChars} characters.`),
      })
    )
    .min(1, "Write a message first.")
    .max(SITE_ASSISTANT_LIMITS.maxIncomingTurns, "This chat is too long — please start a new one."),
  lang: z.enum(["en", "ar"]).default("en"),
  page: z.string().max(120).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

// شكل الرد من المزوّد (JSON)
export const siteAnswerSchema = z.object({
  reply: z.string(),
  suggestions: z.array(z.string()).default([]),
  links: z.array(z.object({ path: z.string(), label: z.string() })).default([]),
});

export const SITE_ANSWER_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, label: { type: "string" } },
        required: ["path", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "suggestions", "links"],
  additionalProperties: false,
};

// تنضيف رد الموديل: طول، لينكات مسموحة بس، من غير تكرار
export function cleanAnswer(raw: z.infer<typeof siteAnswerSchema>): SiteAnswer | null {
  const reply = String(raw.reply ?? "")
    .replace(/```[\s\S]*$/, "")
    .trim()
    .slice(0, SITE_ASSISTANT_LIMITS.maxReplyChars);
  if (!reply) return null;
  const suggestions = [...new Set((raw.suggestions ?? []).map((s) => String(s).trim().slice(0, 120)).filter(Boolean))].slice(0, SITE_ASSISTANT_LIMITS.maxSuggestions);
  const seen = new Set<string>();
  const links: SiteLink[] = [];
  for (const l of raw.links ?? []) {
    const path = String(l.path ?? "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/ar(?=\/|$)/, "").replace(/\/$/, "") || "/";
    if (!ALLOWED_PATHS.has(path) || seen.has(path)) continue;
    seen.add(path);
    links.push({ path, label: String(l.label ?? "").trim().slice(0, 60) || path });
    if (links.length >= SITE_ASSISTANT_LIMITS.maxLinks) break;
  }
  return { reply, suggestions, links };
}
