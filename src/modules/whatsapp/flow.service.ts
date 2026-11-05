import { NotFoundError, ValidationError } from "../../core/errors";
import { renderBotReply } from "./bot";
import { decideFlow, flowInputSchema, flowMessagePreview, flowProblem, renderFlowNode, type FlowInput } from "./flow-engine";
import type { FlowMessenger, FlowStore } from "./flow.repository";

export const MAX_FLOWS = 20;

export interface FlowInbound {
  phone: string;
  name: string | null;
  text: string;
  type: string;
  replyId: string | null;
}

// السيناريوهات: إدارة (التاجر) + تشغيل على كل رسالة جاية (الـ webhook)
export class FlowService {
  constructor(
    private readonly store: FlowStore,
    private readonly messenger: FlowMessenger,
    private readonly now: () => Date = () => new Date()
  ) {}

  private validate(raw: unknown): FlowInput {
    const parsed = flowInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(`${issue.path.join(".") || "flow"}: ${issue.message}`);
    }
    const problem = flowProblem(parsed.data);
    if (problem) throw new ValidationError(problem);
    return parsed.data;
  }

  list(tenantId: string) {
    return this.store.list(tenantId);
  }

  async create(tenantId: string, raw: unknown) {
    const input = this.validate(raw);
    const existing = await this.store.list(tenantId);
    if (existing.length >= MAX_FLOWS) throw new ValidationError(`You can have up to ${MAX_FLOWS} flows.`);
    const id = await this.store.create(tenantId, input, existing.length);
    return (await this.store.get(tenantId, id))!;
  }

  async update(tenantId: string, id: string, raw: unknown) {
    const input = this.validate(raw);
    if (!(await this.store.update(tenantId, id, input))) throw new NotFoundError("Flow not found");
    return (await this.store.get(tenantId, id))!;
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean) {
    if (!(await this.store.setEnabled(tenantId, id, enabled))) throw new NotFoundError("Flow not found");
    return (await this.store.get(tenantId, id))!;
  }

  async remove(tenantId: string, id: string) {
    if (!(await this.store.remove(tenantId, id))) throw new NotFoundError("Flow not found");
  }

  async responses(tenantId: string, id: string) {
    if (!(await this.store.get(tenantId, id))) throw new NotFoundError("Flow not found");
    return this.store.responses(tenantId, id, 200);
  }

  // true = السيناريو رد (الموظف الذكي والبوت مايردوش)
  async handleInbound(tenantId: string, m: FlowInbound): Promise<boolean> {
    if (!["text", "button", "interactive"].includes(m.type)) return false;
    const flows = await this.store.enabled(tenantId);
    if (!flows.length) return false;
    if (await this.store.isWithHuman(tenantId, m.phone)) return false;
    const session = await this.store.session(tenantId, m.phone);
    const decision = decideFlow(flows, session, { text: m.text, replyId: m.replyId }, this.now());
    if (decision.kind === "none") return false;
    if (!(await this.store.accountActive(tenantId))) return false;
    const conn = await this.messenger.connection(tenantId);
    if (!conn) return false;

    // {name} = الاسم اللي العميل كتبه في السيناريو (لو سألناه)، وإلا اسمه على واتساب
    const vars = { name: decision.answers.name ?? m.name ?? "", ...(await this.store.vars(tenantId)) };
    for (const node of decision.send) {
      const msg = renderFlowNode(node, renderBotReply(node.text, vars), decision.retry);
      const sent = await this.messenger.send(conn, m.phone, msg);
      await this.messenger.record({ tenantId, phone: m.phone, name: m.name, body: flowMessagePreview(msg), waMessageId: sent.messageId ?? null, ok: sent.ok, error: sent.ok ? null : sent.error ?? null });
      if (!sent.ok) break;
    }

    const flow = decision.flow;
    await this.store.saveSession(tenantId, m.phone, decision.session ? { flowId: flow.id, ...decision.session } : null);
    if (decision.started) await this.store.countStart(flow.id);
    const name = decision.answers.name ?? null;
    if (decision.tags.length || name) await this.store.tagContact(tenantId, m.phone, decision.tags, name);
    if (decision.completed) await this.store.complete(tenantId, { flowId: flow.id, flowName: flow.name, phone: m.phone, name: name ?? m.name, answers: decision.answers });
    if (decision.handoff) await this.store.handoff(tenantId, m.phone, `Flow “${flow.name}”: the customer asked for your team`);
    return true;
  }
}
