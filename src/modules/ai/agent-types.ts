import { z } from "zod";

// "عقد" موظف الذكاء الاصطناعي على واتساب: أي مزوّد (Claude / Gemini / Fake) بيطبّقه،
// والخدمة مابتعرفش مين. الرد لازم يكون من بيانات الشركة بس - مفيش أسعار أو مواعيد من دماغه

export const AGENT_DIALECTS = ["auto", "qatari", "gulf", "msa", "egyptian", "english"] as const;
export type AgentDialect = (typeof AGENT_DIALECTS)[number];

export interface AgentBusinessContext {
  name: string;
  industry: string;
  currency: string;
  // معلومات كتبها التاجر بنفسه (مواعيد، عنوان، توصيل، سياسات، أسئلة متكررة)
  knowledge: string;
  // المنيو / المنتجات (اسم، سعر منسّق بعملة الشركة، القسم، الوصف)
  menu: { name: string; price: string; category: string; description: string }[];
  // خدمات الحجز (اسم + سعر لو متحدد)
  services: { name: string; price: string | null }[];
  bookingHours: string | null;
  links: { booking: string | null; menu: string | null; links: string | null };
  dialect: AgentDialect;
  // مواعيد فاضية حقيقية (الأيام الجاية) - الموظف يقدر يحجز من المحادثة لو canBookInChat
  booking: AgentBookingInfo | null;
}

export interface AgentBookingInfo {
  // false = الحجز محتاج دفع أونلاين ← الموظف يبعت لينك الحجز بس
  canBookInChat: boolean;
  // لازم العميل يختار خدمة (فيه خدمات بأسعار)
  needsService: boolean;
  days: { date: string; weekday: string; hours: number[] }[];
}

// طلب حجز من الموظف الذكي (date فاضي = مفيش حجز في الرد ده)
export interface AgentBookingRequest {
  date: string;
  hour: number;
  services: string[];
  name: string;
}

export interface AgentTurn {
  from: "customer" | "business";
  text: string;
}

export interface AgentInput {
  business: AgentBusinessContext;
  // آخر رسايل المحادثة (الأقدم الأول) - من غير الرسالة الجديدة
  history: AgentTurn[];
  message: string;
  customerName: string | null;
}

export const agentReplySchema = z.object({
  reply: z.string(),
  // true = الموضوع محتاج موظف (العميل طلب، شكوى، سؤال مش في البيانات، دفع/استرجاع فلوس)
  handoff: z.boolean(),
  reason: z.string().optional().default(""),
  book: z
    .object({ date: z.string().default(""), hour: z.number().int().default(-1), services: z.array(z.string()).default([]), name: z.string().default("") })
    .nullable()
    .optional(),
});
export type AgentReply = z.infer<typeof agentReplySchema>;

export interface AgentResponder {
  readonly model: string;
  reply(input: AgentInput): Promise<CleanAgentReply>;
}

// شكل الرد المطلوب من المزوّد (JSON Schema) - وبنتأكد منه تاني بـ zod
export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    handoff: { type: "boolean" },
    reason: { type: "string" },
    // الحجز: date "YYYY-MM-DD" أو "" لو مفيش حجز، hour 0-23 أو -1
    book: {
      type: "object",
      properties: {
        date: { type: "string" },
        hour: { type: "integer" },
        services: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
      required: ["date", "hour", "services", "name"],
      additionalProperties: false,
    },
  },
  required: ["reply", "handoff", "reason", "book"],
  additionalProperties: false,
};

export const AGENT_LIMITS = { maxReplyChars: 1000, maxMenuItems: 80, maxServices: 40, maxKnowledgeChars: 6000, historyTurns: 12 };

// الموديل أحيانًا بيسرّب كلام زيادة (شوفنا ده لايف في الكاتب) - بنقص عند ``` أو بقايا JSON
// الرد بعد التنظيف: book = null لو الموظف ماطلبش حجز
export type CleanAgentReply = { reply: string; handoff: boolean; reason: string; book: AgentBookingRequest | null };

export function bookingRequestOf(raw: AgentReply["book"]): AgentBookingRequest | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? "") || !Number.isInteger(raw.hour) || raw.hour < 0 || raw.hour > 23) return null;
  return {
    date: raw.date,
    hour: raw.hour,
    services: (raw.services ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 10),
    name: (raw.name ?? "").trim().slice(0, 80),
  };
}

export function cleanAgentReply(raw: AgentReply): CleanAgentReply | null {
  let text = raw.reply ?? "";
  for (const marker of ["```", '"}', "'}", '","handoff']) {
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(0, at);
  }
  text = text.trim().slice(0, AGENT_LIMITS.maxReplyChars);
  if (!text) return null;
  return { reply: text, handoff: Boolean(raw.handoff), reason: (raw.reason ?? "").trim().slice(0, 300), book: bookingRequestOf(raw.book) };
}
