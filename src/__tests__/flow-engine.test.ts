import { describe, expect, it } from "vitest";
import { decideFlow, flowInputSchema, flowProblem, renderFlowNode, type FlowDef, type FlowNode } from "../modules/whatsapp/flow-engine";

const node = (n: Partial<FlowNode> & { id: string }): FlowNode => ({ type: "message", text: n.id, options: [], saveAs: null, next: null, tag: null, ...n });

// سيناريو حجز: ترحيب بزرارين ← (حجز ← اسمك؟ ← تمام) / (موظف ← تحويل)
const flow: FlowDef = {
  id: "f1",
  name: "Welcome",
  enabled: true,
  keywords: ["hi", "مرحبا"],
  startNodeId: "start",
  sortOrder: 0,
  nodes: [
    node({ id: "start", text: "Welcome {name}!", options: [{ label: "Book", next: "ask" }, { label: "Talk to us", next: "human" }, { label: "Prices", next: "prices" }] }),
    node({ id: "ask", type: "question", text: "Your name?", saveAs: "name", next: "done" }),
    node({ id: "done", text: "Thanks! Book here {booking_link}", tag: "lead" }),
    node({ id: "human", type: "handoff", text: "A person will reply soon" }),
    node({ id: "prices", text: "Photo session 1,200 QAR", next: "start2" }),
    node({ id: "start2", text: "Anything else?", options: [{ label: "Book", next: "ask" }] }),
  ],
};
const now = new Date("2026-11-05T10:00:00Z");
const session = (nodeId: string, answers = {}, updatedAt = now) => ({ flowId: "f1", nodeId, answers, updatedAt });

describe("flow engine", () => {
  it("a keyword starts the flow and waits at the first buttons", () => {
    const d = decideFlow([flow], null, { text: "Hi there", replyId: null }, now);
    expect(d.kind).toBe("step");
    if (d.kind !== "step") return;
    expect(d.send.map((n) => n.id)).toEqual(["start"]);
    expect(d.session).toEqual({ nodeId: "start", answers: {} });
    expect(d.started).toBe(true);
  });

  it("unrelated message with no session → nothing (AI / bot answer)", () => {
    expect(decideFlow([flow], null, { text: "how much?", replyId: null }, now).kind).toBe("none");
  });

  it("button id, number or the label text picks the option", () => {
    for (const msg of [{ text: "Book", replyId: "flow:start:0" }, { text: "1", replyId: null }, { text: "book", replyId: null }]) {
      const d = decideFlow([flow], session("start"), msg, now);
      if (d.kind !== "step") throw new Error("expected step");
      expect(d.send.map((n) => n.id)).toEqual(["ask"]);
      expect(d.answers).toEqual({ start: "Book" });
    }
  });

  it("question answer is saved, then the flow ends with the tag and counts as completed", () => {
    const d = decideFlow([flow], session("ask", { start: "Book" }), { text: "Sara Ali", replyId: null }, now);
    if (d.kind !== "step") throw new Error("expected step");
    expect(d.send.map((n) => n.id)).toEqual(["done"]);
    expect(d.answers).toEqual({ start: "Book", name: "Sara Ali" });
    expect(d.session).toBeNull();
    expect(d.completed).toBe(true);
    expect(d.tags).toEqual(["lead"]);
  });

  it("a message without buttons continues by itself to the next step", () => {
    const d = decideFlow([flow], session("start"), { text: "Prices", replyId: null }, now);
    if (d.kind !== "step") throw new Error("expected step");
    expect(d.send.map((n) => n.id)).toEqual(["prices", "start2"]);
    expect(d.session?.nodeId).toBe("start2");
  });

  it("handoff step ends the flow and hands the chat to a person", () => {
    const d = decideFlow([flow], session("start"), { text: "2", replyId: null }, now);
    if (d.kind !== "step") throw new Error("expected step");
    expect(d.handoff).toBe(true);
    expect(d.session).toBeNull();
  });

  it("a wrong answer repeats the same step", () => {
    const d = decideFlow([flow], session("start"), { text: "what?", replyId: null }, now);
    if (d.kind !== "step") throw new Error("expected step");
    expect(d.retry).toBe(true);
    expect(d.send.map((n) => n.id)).toEqual(["start"]);
    expect(renderFlowNode(d.send[0], "Welcome!", true)).toMatchObject({ type: "buttons", text: expect.stringContaining("Please choose") });
  });

  it("sessions expire after 24h; a disabled flow does nothing", () => {
    expect(decideFlow([flow], session("start", {}, new Date(now.getTime() - 25 * 3600_000)), { text: "1", replyId: null }, now).kind).toBe("none");
    expect(decideFlow([{ ...flow, enabled: false }], null, { text: "hi", replyId: null }, now).kind).toBe("none");
  });

  it("the keyword restarts the flow, but not while answering a question", () => {
    const d = decideFlow([flow], session("start2"), { text: "hi", replyId: null }, now);
    if (d.kind !== "step") throw new Error("expected step");
    expect(d.started).toBe(true);
    const q = decideFlow([flow], session("ask"), { text: "hi", replyId: null }, now);
    if (q.kind !== "step") throw new Error("expected step");
    expect(q.answers.name).toBe("hi");
  });

  it("renders buttons (≤3 short), a list (more), or plain text", () => {
    expect(renderFlowNode(flow.nodes[0], "x", false)).toEqual({ type: "buttons", text: "x", buttons: [{ id: "flow:start:0", title: "Book" }, { id: "flow:start:1", title: "Talk to us" }, { id: "flow:start:2", title: "Prices" }] });
    const many = node({ id: "m", options: Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}`, next: null })) });
    expect(renderFlowNode(many, "x", false).type).toBe("list");
    expect(renderFlowNode(flow.nodes[1], "Your name?", false)).toEqual({ type: "text", text: "Your name?" });
  });

  it("validation catches broken links and bad steps", () => {
    const base = { name: "x", enabled: true, keywords: ["hi"], startNodeId: "a" };
    const ok = flowInputSchema.parse({ ...base, nodes: [{ id: "a", type: "message", text: "hi", options: [{ label: "Go", next: "b" }] }, { id: "b", type: "handoff", text: "ok" }] });
    expect(flowProblem(ok)).toBeNull();
    expect(flowProblem({ ...ok, startNodeId: "zzz" })).toMatch(/first step/);
    expect(flowProblem({ ...ok, nodes: [{ ...ok.nodes[0], options: [{ label: "Go", next: "nope" }] }, ok.nodes[1]] })).toMatch(/doesn't exist/);
    expect(flowProblem({ ...ok, nodes: [ok.nodes[0], { ...ok.nodes[1], next: "a" }] })).toMatch(/nothing can come after/);
    expect(flowProblem({ ...ok, nodes: [{ ...ok.nodes[0], options: [{ label: "Go", next: "b" }, { label: "go", next: "b" }] }, ok.nodes[1]] })).toMatch(/same text/);
    expect(flowInputSchema.safeParse({ ...base, keywords: [], nodes: ok.nodes }).success).toBe(false);
  });
});
