import { randomUUID } from "crypto";
import { InsufficientCreditsError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../core/errors";
import { AGENT_DIALECTS, AGENT_LIMITS, type AgentDialect, type AgentResponder, type AgentTurn } from "../ai/agent-types";
import { AI_COSTS } from "../ai/ai-pricing";
import type { CreditService } from "../credits/credit.service";
import type { AgentBooker, AgentBookResult } from "./agent-booking";
import type { AgentBookingInfo } from "../ai/agent-types";
import type { AgentMessenger, AgentSettings, AiAgentStore, ConversationState, ConversationStatus } from "./ai-agent.repository";

export const AGENT_RULES = {
  cost: AI_COSTS.agent,
  // التاجر رد بنفسه ← الموظف الذكي يسكت على المحادثة دي المدة دي
  humanPauseMs: 12 * 3600_000,
  replyTypes: new Set(["text", "button", "interactive"]),
  maxHistory: AGENT_LIMITS.historyTurns,
};

// نتيجة رسالة جاية: replied = الموظف الذكي رد، human = المحادثة مع موظف (البوت كمان يسكت)،
// skipped = مش شغال / مفيش نقاط / حصل خطأ ← البوت العادي (الكلمات المفتاحية) ياخد دوره
export type AgentOutcome = "replied" | "human" | "skipped";

export interface InboundMessage {
  phone: string;
  name: string | null;
  text: string;
  type: string;
  // العميل جه دلوقتي من إعلان Click-to-WhatsApp (عنوان + كلام الإعلان)
  ad?: { headline: string; body: string } | null;
}

export class AiAgentService {
  constructor(
    private readonly store: AiAgentStore,
    private readonly messenger: AgentMessenger,
    private readonly responder: AgentResponder | null,
    private readonly credits: CreditService,
    private readonly booker: AgentBooker | null = null,
    private readonly now: () => Date = () => new Date()
  ) {}

  // بيانات الشركة + المواعيد الفاضية (لو الحجز من المحادثة متاح)
  private async context(tenantId: string, settings: AgentSettings) {
    const business = await this.store.businessContext(tenantId, settings);
    if (business && this.booker) business.booking = await this.booker.info(tenantId, this.now()).catch(() => null);
    return business;
  }

  get isAvailable() {
    return this.responder !== null;
  }

  async getSettings(tenantId: string) {
    return { ...(await this.store.settings(tenantId)), available: this.isAvailable, cost: AGENT_RULES.cost };
  }

  async saveSettings(tenantId: string, input: Partial<AgentSettings>) {
    const current = await this.store.settings(tenantId);
    const next: AgentSettings = {
      enabled: input.enabled ?? current.enabled,
      knowledge: (input.knowledge ?? current.knowledge).slice(0, AGENT_LIMITS.maxKnowledgeChars),
      dialect: (AGENT_DIALECTS as readonly string[]).includes(input.dialect ?? "") ? (input.dialect as AgentDialect) : current.dialect,
      maxRepliesPerHour: Math.min(30, Math.max(1, Math.round(input.maxRepliesPerHour ?? current.maxRepliesPerHour))),
    };
    if (next.enabled && !this.isAvailable) throw new ServiceUnavailableError("The AI assistant isn't switched on for the platform yet — please contact support.");
    await this.store.saveSettings(tenantId, next);
    return this.getSettings(tenantId);
  }

  // "جرّب الموظف": رد على رسالة كإن التاجر عميل - مابيتبعتش لحد، بس بيتكلّف نقطة
  async test(tenantId: string, userId: string, message: string, history: AgentTurn[] = []) {
    if (!this.responder) throw new ServiceUnavailableError("The AI assistant isn't switched on for the platform yet — please contact support.");
    const text = message.trim();
    if (!text) throw new ValidationError("Write a message to test with.");
    const settings = await this.store.settings(tenantId);
    const business = await this.context(tenantId, settings);
    if (!business) throw new NotFoundError("Company not found");
    const { result, balance } = await this.credits.chargeFor({ tenantId, cost: AGENT_RULES.cost, reason: "AI_AGENT_TEST", userId, refId: randomUUID() }, () =>
      this.responder!.reply({ business, history: history.slice(-AGENT_RULES.maxHistory), message: text.slice(0, 2000), customerName: null })
    );
    // في التجربة مابنحجزش فعلًا - بنوري التاجر الحجز اللي كان هيتعمل
    return { reply: result.reply, handoff: result.handoff, reason: result.reason, wouldBook: result.book, balance, creditsUsed: AGENT_RULES.cost };
  }

  // كل رسالة واتساب جاية من عميل (من الـ webhook)
  async handleInbound(tenantId: string, m: InboundMessage): Promise<AgentOutcome> {
    const at = this.now();
    const conv = await this.store.touchInbound(tenantId, m.phone, at);
    if (conv.status === "handoff") return "human";
    if (conv.aiPausedUntil && conv.aiPausedUntil.getTime() > at.getTime()) return "human";

    const settings = await this.store.settings(tenantId);
    if (!settings.enabled || !this.responder) return "skipped";
    if (!AGENT_RULES.replyTypes.has(m.type) || !m.text.trim()) return "skipped";
    if (!(await this.store.accountActive(tenantId))) return "skipped";
    const conn = await this.messenger.connection(tenantId, m.phone);
    if (!conn) return "skipped";

    // حماية النقاط: محادثة بتلف (أو حد بيبعت كتير) ← تتحوّل لموظف
    const recent = await this.store.aiRepliesSince(tenantId, m.phone, new Date(at.getTime() - 3600_000));
    if (recent >= settings.maxRepliesPerHour) {
      await this.store.updateConversation(tenantId, m.phone, { status: "handoff", handoffReason: "Many messages in a short time — please reply yourself" });
      return "human";
    }

    const business = await this.context(tenantId, settings);
    if (!business) return "skipped";
    const history = await this.store.history(tenantId, m.phone, AGENT_RULES.maxHistory + 1);
    // آخر رسالة في السجل هي الرسالة دي نفسها (اتسجلت قبل ما نوصل هنا)
    const last = history[history.length - 1];
    if (last && last.from === "customer" && last.text === m.text) history.pop();

    let reply;
    try {
      ({ result: reply } = await this.credits.chargeFor({ tenantId, cost: AGENT_RULES.cost, reason: "AI_AGENT", refId: randomUUID() }, () =>
        this.responder!.reply({ business, history, message: m.text, customerName: m.name, ad: m.ad ?? null })
      ));
    } catch (err) {
      // من غير نقاط أو المزوّد وقع: النقطة رجعت (chargeFor) والبوت العادي يرد
      if (!(err instanceof InsufficientCreditsError)) console.warn(`[whatsapp-ai] reply failed for tenant ${tenantId}: ${(err as Error)?.message}`);
      return "skipped";
    }

    // الموظف طلب حجز ← نحجز فعلًا (نفس تحقق صفحة الحجز). نجح والتأكيد اتبعت = مفيش رسالة تانية
    let text: string | null = reply.reply;
    let handoff = reply.handoff ? reply.reason || "The assistant passed this to the team" : null;
    if (reply.book && this.booker && business.booking?.canBookInChat) {
      const result = await this.booker.book(tenantId, { ...reply.book, name: reply.book.name || m.name || "", phone: m.phone }, at);
      if (result.ok) {
        if (result.confirmationSent) text = null;
      } else {
        text = bookingProblemText(result, m.text, business.booking, business.links.booking, business.services.map((x) => x.name));
        if (!["slot_not_free", "service_needed"].includes(result.error)) handoff = `The assistant couldn't finish a booking: ${result.error}`.slice(0, 300);
      }
    }

    if (text) {
      const sent = await this.messenger.sendText(conn, m.phone, text);
      await this.messenger.record({ tenantId, phone: m.phone, name: m.name, body: text, waMessageId: sent.messageId ?? null, ok: sent.ok, error: sent.ok ? null : sent.error ?? null, phoneNumberId: conn.phoneNumberId });
    }
    if (handoff) await this.store.updateConversation(tenantId, m.phone, { status: "handoff", handoffReason: handoff });
    return "replied";
  }

  // رسالة جاية اترد عليها من مكان تاني (سيناريو) - بس نسجّل إن العميل كتب
  async noteInbound(tenantId: string, phone: string) {
    await this.store.touchInbound(tenantId, phone, this.now());
  }

  // التاجر/الموظف رد بنفسه من Team Inbox ← الموظف الذكي يسكت شوية على المحادثة دي
  async humanReplied(tenantId: string, phone: string) {
    await this.store.updateConversation(tenantId, phone, { aiPausedUntil: new Date(this.now().getTime() + AGENT_RULES.humanPauseMs) });
  }

  // --- حالة المحادثات (Team Inbox) ---

  conversationStates(tenantId: string, phones: string[]): Promise<Map<string, ConversationState>> {
    return this.store.conversations(tenantId, phones);
  }

  async updateConversation(tenantId: string, phone: string, input: { status?: ConversationStatus; assignedToUserId?: string | null; resumeAi?: boolean }) {
    const data: Partial<Omit<ConversationState, "phone">> = {};
    if (input.status) {
      data.status = input.status;
      if (input.status !== "handoff") data.handoffReason = null;
    }
    if (input.assignedToUserId !== undefined) data.assignedToUserId = input.assignedToUserId;
    if (input.resumeAi) {
      data.aiPausedUntil = null;
      if (!input.status) {
        data.status = "open";
        data.handoffReason = null;
      }
    }
    return this.store.updateConversation(tenantId, phone, data);
  }
}

const ARABIC = /[؀-ۿ]/;

// الحجز ماتمّش ← رسالة واضحة بلغة العميل + أقرب مواعيد فاضية (من الداتا، مش من الموديل)
export function bookingProblemText(result: Extract<AgentBookResult, { ok: false }>, customerText: string, info: AgentBookingInfo, bookingLink: string | null, services: string[]): string {
  const ar = ARABIC.test(customerText);
  const fmt = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const next = info.days.filter((d) => d.hours.length).slice(0, 2).map((d) => `${d.date}: ${d.hours.slice(0, 4).map(fmt).join(", ")}`).join("\n");
  if (result.error === "service_needed") {
    return ar ? `عشان أكمل الحجز، اختار الخدمة لو سمحت: ${services.join("، ")}` : `To finish the booking, please choose the service: ${services.join(", ")}`;
  }
  if (result.error === "slot_not_free") {
    if (next) return ar ? `للأسف الميعاد ده مش متاح 🙏 أقرب مواعيد فاضية:\n${next}` : `Sorry, that time isn't available 🙏 The nearest free times:\n${next}`;
    return ar ? `للأسف مفيش مواعيد فاضية الأيام الجاية 🙏${bookingLink ? ` تقدر تشوف المواعيد هنا: ${bookingLink}` : ""}` : `Sorry, there are no free times in the next days 🙏${bookingLink ? ` You can check here: ${bookingLink}` : ""}`;
  }
  return ar
    ? `معلش، ماقدرتش أكمل الحجز من هنا 🙏 حد من الفريق هيكلمك حالًا${bookingLink ? `، أو احجز من هنا: ${bookingLink}` : "."}`
    : `Sorry, I couldn't finish the booking here 🙏 A team member will contact you shortly${bookingLink ? `, or book here: ${bookingLink}` : "."}`;
}
