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
});
export type AgentReply = z.infer<typeof agentReplySchema>;

export interface AgentResponder {
  readonly model: string;
  reply(input: AgentInput): Promise<AgentReply>;
}

// شكل الرد المطلوب من المزوّد (JSON Schema) - وبنتأكد منه تاني بـ zod
export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    handoff: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["reply", "handoff", "reason"],
  additionalProperties: false,
};

export const AGENT_LIMITS = { maxReplyChars: 1000, maxMenuItems: 80, maxServices: 40, maxKnowledgeChars: 6000, historyTurns: 12 };

// الموديل أحيانًا بيسرّب كلام زيادة (شوفنا ده لايف في الكاتب) - بنقص عند ``` أو بقايا JSON
export function cleanAgentReply(raw: AgentReply): AgentReply | null {
  let text = raw.reply ?? "";
  for (const marker of ["```", '"}', "'}", '","handoff']) {
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(0, at);
  }
  text = text.trim().slice(0, AGENT_LIMITS.maxReplyChars);
  if (!text) return null;
  return { reply: text, handoff: Boolean(raw.handoff), reason: (raw.reason ?? "").trim().slice(0, 300) };
}
