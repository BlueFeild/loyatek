import { z } from "zod";
import { keywordMatches, normalizeForMatch } from "./bot";

// سيناريوهات واتساب (Flow Builder): العميل يكتب كلمة ← البوت يبعت رسالة بأزرار ← كل زرار يودّي لخطوة،
// أو سؤال يتحفظ جوابه، أو تحويل لموظف. هنا المنطق بس (من غير قاعدة بيانات ولا Meta) - سهل يتختبر

export const FLOW_LIMITS = { maxNodes: 30, maxOptions: 10, maxText: 1000, maxLabel: 24, maxKeywords: 10, sessionTtlMs: 24 * 3600_000 } as const;

export const FLOW_NODE_TYPES = ["message", "question", "handoff"] as const;
export const FLOW_SAVE_AS = ["name", "email", "phone", "note"] as const;

const nodeId = z.string().trim().min(1).max(40).regex(/^[\w-]+$/);

export const flowNodeSchema = z.object({
  id: nodeId,
  type: z.enum(FLOW_NODE_TYPES),
  text: z.string().trim().min(1).max(FLOW_LIMITS.maxText),
  // message: اختيارات (أزرار / قايمة) كل واحد بيودّي لخطوة. مفيش اختيارات = آخر السيناريو (أو next)
  options: z.array(z.object({ label: z.string().trim().min(1).max(FLOW_LIMITS.maxLabel), next: nodeId.nullable() })).max(FLOW_LIMITS.maxOptions).default([]),
  // question: الجواب يتحفظ باسم ده
  saveAs: z.enum(FLOW_SAVE_AS).nullable().default(null),
  // الخطوة اللي بعدها (للسؤال، أو رسالة من غير اختيارات)
  next: nodeId.nullable().default(null),
  // العميل اللي يوصل للخطوة دي ياخد التاج ده في دفتر جهات الاتصال
  tag: z.string().trim().max(40).nullable().default(null),
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const FLOW_CHANNELS = ["whatsapp", "instagram", "messenger"] as const;
export type FlowChannel = (typeof FLOW_CHANNELS)[number];

export const flowInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  keywords: z.array(z.string().trim().min(1).max(40)).min(1).max(FLOW_LIMITS.maxKeywords),
  startNodeId: nodeId,
  nodes: z.array(flowNodeSchema).min(1).max(FLOW_LIMITS.maxNodes),
  // شغال فين: واتساب و/أو رسايل انستجرام و/أو ماسنجر
  channels: z.array(z.enum(FLOW_CHANNELS)).min(1, "Choose where the flow runs").default(["whatsapp"]),
});
export type FlowInput = z.infer<typeof flowInputSchema>;

// مشاكل في السيناريو (خطوة مش موجودة، أرقام مكررة...) - null = تمام
export function flowProblem(f: FlowInput): string | null {
  const ids = new Set<string>();
  for (const n of f.nodes) {
    if (ids.has(n.id)) return `Two steps have the same id "${n.id}".`;
    ids.add(n.id);
  }
  if (!ids.has(f.startNodeId)) return "The first step doesn't exist.";
  for (const n of f.nodes) {
    if (n.type === "question" && n.options.length) return `Step "${n.id}" is a question — it can't have buttons.`;
    if (n.type === "handoff" && (n.options.length || n.next)) return `Step "${n.id}" hands the chat to your team — nothing can come after it.`;
    for (const o of n.options) if (o.next && !ids.has(o.next)) return `The button "${o.label}" goes to a step that doesn't exist.`;
    if (n.next && !ids.has(n.next)) return `Step "${n.id}" goes to a step that doesn't exist.`;
    const labels = new Set(n.options.map((o) => normalizeForMatch(o.label)));
    if (labels.size !== n.options.length) return `Step "${n.id}" has two buttons with the same text.`;
  }
  return null;
}

export interface FlowDef {
  id: string;
  name: string;
  enabled: boolean;
  keywords: string[];
  startNodeId: string;
  nodes: FlowNode[];
  sortOrder: number;
  channels?: string[];
}

export interface FlowSessionState {
  flowId: string;
  nodeId: string;
  answers: Record<string, string>;
  updatedAt: Date;
}

export interface FlowIncoming {
  text: string;
  // id الزرار / الاختيار اللي العميل داس عليه (من رسالة interactive)
  replyId: string | null;
}

// اللي المحرّك قرره للرسالة دي
export type FlowDecision =
  | { kind: "none" }
  | {
      kind: "step";
      flow: FlowDef;
      // الخطوات اللي هتتبعت دلوقتي بالترتيب (رسالة من غير اختيارات بتكمّل للي بعدها لوحدها)
      send: FlowNode[];
      // الحالة الجديدة (null = السيناريو خلص)
      session: { nodeId: string; answers: Record<string, string> } | null;
      started: boolean;
      completed: boolean;
      handoff: boolean;
      tags: string[];
      answers: Record<string, string>;
      // العميل كتب حاجة مش من الاختيارات ← نعيد نفس الخطوة
      retry: boolean;
    };

export const optionReplyId = (nodeId: string, index: number) => `flow:${nodeId}:${index}`;

function pickOption(node: FlowNode, msg: FlowIncoming): number {
  if (msg.replyId?.startsWith(`flow:${node.id}:`)) {
    const i = Number(msg.replyId.slice(`flow:${node.id}:`.length));
    if (Number.isInteger(i) && i >= 0 && i < node.options.length) return i;
  }
  const t = normalizeForMatch(msg.text);
  if (/^\d{1,2}$/.test(t)) {
    const i = Number(t) - 1;
    if (i >= 0 && i < node.options.length) return i;
  }
  return node.options.findIndex((o) => normalizeForMatch(o.label) === t);
}

// من خطوة: نبعتها، ولو هي رسالة من غير اختيارات وليها next نكمّل (حد أقصى عشان مايلفّش)
function walk(flow: FlowDef, startId: string | null, answers: Record<string, string>) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const send: FlowNode[] = [];
  const tags: string[] = [];
  let current = startId ? byId.get(startId) ?? null : null;
  let waitingAt: FlowNode | null = null;
  let handoff = false;
  const seen = new Set<string>();
  while (current && !seen.has(current.id) && send.length < 5) {
    seen.add(current.id);
    send.push(current);
    if (current.tag) tags.push(current.tag);
    if (current.type === "handoff") {
      handoff = true;
      break;
    }
    if (current.type === "question" || current.options.length) {
      waitingAt = current;
      break;
    }
    current = current.next ? byId.get(current.next) ?? null : null;
  }
  return { send, tags, handoff, session: waitingAt ? { nodeId: waitingAt.id, answers } : null };
}

export function startedBy(flows: FlowDef[], text: string): FlowDef | null {
  const sorted = [...flows].filter((f) => f.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  return sorted.find((f) => f.keywords.some((k) => keywordMatches(text, k))) ?? null;
}

export function decideFlow(flows: FlowDef[], session: FlowSessionState | null, msg: FlowIncoming, now: Date): FlowDecision {
  const active = session && now.getTime() - session.updatedAt.getTime() < FLOW_LIMITS.sessionTtlMs ? session : null;
  const flow = active ? flows.find((f) => f.id === active.flowId && f.enabled) ?? null : null;
  const node = flow ? flow.nodes.find((n) => n.id === active!.nodeId) ?? null : null;

  // كلمة سيناريو تاني (أو نفس السيناريو من الأول) بتبدأه من جديد - إلا لو إحنا مستنيين جواب سؤال
  const trigger = startedBy(flows, msg.text);
  const answeringQuestion = node?.type === "question";
  if (trigger && !answeringQuestion && !(node && pickOption(node, msg) >= 0)) {
    const w = walk(trigger, trigger.startNodeId, {});
    return { kind: "step", flow: trigger, ...w, started: true, completed: !w.session, answers: {}, retry: false };
  }
  if (!flow || !node) return { kind: "none" };

  if (node.type === "question") {
    const answer = msg.text.trim().slice(0, 500);
    if (!answer || msg.text.startsWith("[")) {
      return { kind: "step", flow, send: [node], session: { nodeId: node.id, answers: active!.answers }, started: false, completed: false, handoff: false, tags: [], answers: active!.answers, retry: true };
    }
    const answers = { ...active!.answers, [node.saveAs ?? node.id]: answer };
    const w = walk(flow, node.next, answers);
    return { kind: "step", flow, ...w, started: false, completed: !w.session, answers, retry: false };
  }

  const i = pickOption(node, msg);
  if (i < 0) {
    return { kind: "step", flow, send: [node], session: { nodeId: node.id, answers: active!.answers }, started: false, completed: false, handoff: false, tags: [], answers: active!.answers, retry: true };
  }
  const answers = { ...active!.answers, [node.id]: node.options[i].label };
  const w = walk(flow, node.options[i].next, answers);
  return { kind: "step", flow, ...w, started: false, completed: !w.session, answers, retry: false };
}

// شكل الرسالة عند Meta: ≤3 اختيارات قصيرة = أزرار، ≤10 = قايمة، غير كده نص بأرقام
export type OutgoingFlowMessage =
  | { type: "text"; text: string }
  | { type: "buttons"; text: string; buttons: { id: string; title: string }[] }
  | { type: "list"; text: string; button: string; rows: { id: string; title: string }[] };

export function renderFlowNode(node: FlowNode, text: string, retry: boolean): OutgoingFlowMessage {
  const body = retry ? `${text}\n\n(Please choose one of the options 👇)` : text;
  if (node.type !== "message" || node.options.length === 0) return { type: "text", text: body };
  const opts = node.options.map((o, i) => ({ id: optionReplyId(node.id, i), title: o.label }));
  if (opts.length <= 3 && opts.every((o) => o.title.length <= 20)) return { type: "buttons", text: body, buttons: opts };
  return { type: "list", text: body, button: "Choose", rows: opts };
}

// للتسجيل في Team Inbox (اللي العميل شافه)
export function flowMessagePreview(m: OutgoingFlowMessage): string {
  if (m.type === "text") return m.text;
  const opts = m.type === "buttons" ? m.buttons : m.rows;
  return `${m.text}\n${opts.map((o, i) => `${i + 1}. ${o.title}`).join("\n")}`;
}
