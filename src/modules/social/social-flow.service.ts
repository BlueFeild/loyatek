import { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { renderBotReply } from "../whatsapp/bot";
import { decideFlow, flowMessagePreview, renderFlowNode, type FlowDef, type FlowSessionState } from "../whatsapp/flow-engine";
import type { InboxAccountRow, InboxStore } from "./social-inbox.repository";
import type { InboxAccount, InboxEvent, SocialInboxGateway } from "./social-types";

// نفس سيناريوهات الـ Flow Builder بتاعة واتساب، بس على رسايل انستجرام وماسنجر الخاصة.
// الزراير = Quick replies. جلسة العميل مفتاحها "ig:<الحساب>:<العميل>" أو "fb:..." عشان ماتختلطش بأرقام واتساب

export interface SocialFlowStore {
  enabled(tenantId: string): Promise<FlowDef[]>;
  session(tenantId: string, key: string): Promise<FlowSessionState | null>;
  saveSession(tenantId: string, key: string, s: { flowId: string; nodeId: string; answers: Record<string, string> } | null): Promise<void>;
  countStart(flowId: string): Promise<void>;
  complete(tenantId: string, r: { flowId: string; flowName: string; key: string; name: string | null; answers: Record<string, string> }): Promise<void>;
  // التاجر رد بنفسه على المحادثة دي قريب؟ (ساعتها السيناريو يسكت)
  staffRepliedSince(accountId: string, threadKey: string, since: Date): Promise<boolean>;
  vars(tenantId: string): Promise<Record<string, string>>;
}

// الموظف رد بإيده: السيناريو يسكت 12 ساعة (زي الموظف الذكي في واتساب)
const STAFF_PAUSE_MS = 12 * 60 * 60 * 1000;

export class SocialFlowService {
  constructor(
    private readonly store: SocialFlowStore,
    private readonly gateway: SocialInboxGateway,
    private readonly inbox: Pick<InboxStore, "record">,
    private readonly now: () => Date = () => new Date()
  ) {}

  // true = السيناريو رد على الرسالة
  async handle(tenantId: string, account: InboxAccountRow, inbox: InboxAccount, e: InboxEvent): Promise<boolean> {
    if (e.kind !== "DM" || e.direction !== "IN") return false;
    const channel = e.platform === "INSTAGRAM" ? "instagram" : "messenger";
    const flows = (await this.store.enabled(tenantId)).filter((f) => f.channels?.includes(channel));
    if (!flows.length) return false;
    const key = `${e.platform === "INSTAGRAM" ? "ig" : "fb"}:${account.id}:${e.threadKey}`;
    const now = this.now();
    if (await this.store.staffRepliedSince(account.id, e.threadKey, new Date(now.getTime() - STAFF_PAUSE_MS))) return false;

    const session = await this.store.session(tenantId, key);
    const decision = decideFlow(flows, session, { text: e.text, replyId: e.replyId ?? null }, now);
    if (decision.kind === "none") return false;

    const vars = { name: decision.answers.name ?? e.authorName ?? "", ...(await this.store.vars(tenantId)) };
    for (const node of decision.send) {
      const msg = renderFlowNode(node, renderBotReply(node.text, vars), decision.retry);
      const options = msg.type === "buttons" ? msg.buttons : msg.type === "list" ? msg.rows : [];
      let sentId: string;
      try {
        sentId = options.length && this.gateway.sendQuickReplies
          ? (await this.gateway.sendQuickReplies(inbox, e.threadKey, msg.text, options)).id
          : (await this.gateway.sendDirectMessage(inbox, e.threadKey, options.length ? flowMessagePreview(msg) : msg.text)).id;
      } catch (err) {
        console.warn(`[social-flow] sending to ${e.platform} failed: ${(err as Error)?.message}`);
        break;
      }
      await this.inbox.record(tenantId, account.id, [
        {
          platform: e.platform,
          accountExternalId: account.externalId,
          kind: "DM",
          direction: "OUT",
          externalId: sentId,
          threadKey: e.threadKey,
          parentExternalId: null,
          postExternalId: null,
          postCaption: null,
          authorId: null,
          authorName: `Flow: ${decision.flow.name}`,
          text: flowMessagePreview(msg),
          createdAt: this.now(),
        },
      ]);
    }

    const flow = decision.flow;
    await this.store.saveSession(tenantId, key, decision.session ? { flowId: flow.id, ...decision.session } : null);
    if (decision.started) await this.store.countStart(flow.id);
    if (decision.completed) await this.store.complete(tenantId, { flowId: flow.id, flowName: flow.name, key, name: decision.answers.name ?? e.authorName ?? null, answers: decision.answers });
    return true;
  }
}

// التخزين: نفس جداول سيناريوهات واتساب (الجلسات والإجابات)
export class PrismaSocialFlowStore implements SocialFlowStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly shared: Pick<SocialFlowStore, "enabled" | "session" | "saveSession" | "countStart" | "vars">
  ) {}

  enabled(tenantId: string) {
    return this.shared.enabled(tenantId);
  }
  session(tenantId: string, key: string) {
    return this.shared.session(tenantId, key);
  }
  saveSession(tenantId: string, key: string, s: { flowId: string; nodeId: string; answers: Record<string, string> } | null) {
    return this.shared.saveSession(tenantId, key, s);
  }
  countStart(flowId: string) {
    return this.shared.countStart(flowId);
  }
  vars(tenantId: string) {
    return this.shared.vars(tenantId);
  }

  async complete(tenantId: string, r: { flowId: string; flowName: string; key: string; name: string | null; answers: Record<string, string> }) {
    await this.db.whatsappFlow.updateMany({ where: { id: r.flowId, tenantId }, data: { completedCount: { increment: 1 } } });
    if (!Object.keys(r.answers).length) return;
    await this.db.whatsappFlowResponse.create({ data: { tenantId, flowId: r.flowId, flowName: r.flowName, phone: r.key, name: r.name, answers: r.answers as Prisma.InputJsonValue } });
  }

  async staffRepliedSince(accountId: string, threadKey: string, since: Date) {
    return (await this.db.socialMessage.count({ where: { accountId, kind: "DM", threadKey, direction: "OUT", sentById: { not: null }, createdAt: { gte: since } } })) > 0;
  }
}
