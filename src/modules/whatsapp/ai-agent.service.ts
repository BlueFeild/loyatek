import { randomUUID } from "crypto";
import { InsufficientCreditsError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../core/errors";
import { AGENT_DIALECTS, AGENT_LIMITS, type AgentDialect, type AgentResponder, type AgentTurn } from "../ai/agent-types";
import { AI_COSTS } from "../ai/ai-pricing";
import type { CreditService } from "../credits/credit.service";
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
}

export class AiAgentService {
  constructor(
    private readonly store: AiAgentStore,
    private readonly messenger: AgentMessenger,
    private readonly responder: AgentResponder | null,
    private readonly credits: CreditService,
    private readonly now: () => Date = () => new Date()
  ) {}

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
    const business = await this.store.businessContext(tenantId, settings);
    if (!business) throw new NotFoundError("Company not found");
    const { result, balance } = await this.credits.chargeFor({ tenantId, cost: AGENT_RULES.cost, reason: "AI_AGENT_TEST", userId, refId: randomUUID() }, () =>
      this.responder!.reply({ business, history: history.slice(-AGENT_RULES.maxHistory), message: text.slice(0, 2000), customerName: null })
    );
    return { ...result, balance, creditsUsed: AGENT_RULES.cost };
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
    const conn = await this.messenger.connection(tenantId);
    if (!conn) return "skipped";

    // حماية النقاط: محادثة بتلف (أو حد بيبعت كتير) ← تتحوّل لموظف
    const recent = await this.store.aiRepliesSince(tenantId, m.phone, new Date(at.getTime() - 3600_000));
    if (recent >= settings.maxRepliesPerHour) {
      await this.store.updateConversation(tenantId, m.phone, { status: "handoff", handoffReason: "Many messages in a short time — please reply yourself" });
      return "human";
    }

    const business = await this.store.businessContext(tenantId, settings);
    if (!business) return "skipped";
    const history = await this.store.history(tenantId, m.phone, AGENT_RULES.maxHistory + 1);
    // آخر رسالة في السجل هي الرسالة دي نفسها (اتسجلت قبل ما نوصل هنا)
    const last = history[history.length - 1];
    if (last && last.from === "customer" && last.text === m.text) history.pop();

    let reply;
    try {
      ({ result: reply } = await this.credits.chargeFor({ tenantId, cost: AGENT_RULES.cost, reason: "AI_AGENT", refId: randomUUID() }, () =>
        this.responder!.reply({ business, history, message: m.text, customerName: m.name })
      ));
    } catch (err) {
      // من غير نقاط أو المزوّد وقع: النقطة رجعت (chargeFor) والبوت العادي يرد
      if (!(err instanceof InsufficientCreditsError)) console.warn(`[whatsapp-ai] reply failed for tenant ${tenantId}: ${(err as Error)?.message}`);
      return "skipped";
    }

    const sent = await this.messenger.sendText(conn, m.phone, reply.reply);
    await this.messenger.record({ tenantId, phone: m.phone, name: m.name, body: reply.reply, waMessageId: sent.messageId ?? null, ok: sent.ok, error: sent.ok ? null : sent.error ?? null });
    if (reply.handoff) await this.store.updateConversation(tenantId, m.phone, { status: "handoff", handoffReason: reply.reason || "The assistant passed this to the team" });
    return "replied";
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
