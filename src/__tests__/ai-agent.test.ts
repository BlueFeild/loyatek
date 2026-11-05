import { describe, expect, it } from "vitest";
import { AiAgentService } from "../modules/whatsapp/ai-agent.service";
import { DEFAULT_AGENT_SETTINGS, type AgentMessenger, type AgentSettings, type AiAgentStore, type ConversationState } from "../modules/whatsapp/ai-agent.repository";
import type { AgentBusinessContext, AgentTurn } from "../modules/ai/agent-types";
import { cleanAgentReply } from "../modules/ai/agent-types";
import { buildAgentPrompt } from "../modules/ai/agent.prompts";
import { FakeAgentResponder } from "../modules/ai/agent-responders";
import { CreditService } from "../modules/credits/credit.service";
import { MemoryCredits } from "./helpers/ai-memory-stores";

const business = (over: Partial<AgentBusinessContext> = {}): AgentBusinessContext => ({
  name: "Karak House",
  industry: "HOSPITALITY",
  currency: "QAR",
  knowledge: "Open 7am–11pm. Delivery in Doha only.",
  menu: [{ name: "Karak", price: "QAR 5.00", category: "Drinks", description: "" }],
  services: [],
  bookingHours: null,
  links: { booking: null, menu: "https://x.test/menu/karak", links: null },
  dialect: "auto",
  booking: null,
  ...over,
});

class MemoryAgentStore implements AiAgentStore {
  s: Record<string, AgentSettings> = {};
  convs = new Map<string, ConversationState>();
  messages: { tenantId: string; phone: string; dir: "IN" | "OUT"; kind: string; text: string; at: Date }[] = [];
  active = true;
  key = (t: string, p: string) => `${t}:${p}`;
  async settings(t: string) {
    return this.s[t] ?? { ...DEFAULT_AGENT_SETTINGS };
  }
  async saveSettings(t: string, v: AgentSettings) {
    this.s[t] = v;
    return v;
  }
  async businessContext(t: string, settings: AgentSettings) {
    return t === "missing" ? null : business({ dialect: settings.dialect, knowledge: settings.knowledge });
  }
  async accountActive() {
    return this.active;
  }
  async history(t: string, p: string, limit: number): Promise<AgentTurn[]> {
    return this.messages.filter((m) => m.tenantId === t && m.phone === p).slice(-limit).map((m) => ({ from: m.dir === "IN" ? "customer" : "business", text: m.text }));
  }
  async aiRepliesSince(t: string, p: string, since: Date) {
    return this.messages.filter((m) => m.tenantId === t && m.phone === p && m.dir === "OUT" && m.kind === "ai" && m.at >= since).length;
  }
  async touchInbound(t: string, p: string, at: Date) {
    const c = this.convs.get(this.key(t, p)) ?? { phone: p, status: "open" as const, assignedToUserId: null, handoffReason: null, aiPausedUntil: null, lastInboundAt: null };
    const next = { ...c, lastInboundAt: at, status: c.status === "closed" ? ("open" as const) : c.status };
    this.convs.set(this.key(t, p), next);
    return next;
  }
  async conversations(t: string, phones: string[]) {
    return new Map(phones.flatMap((p) => (this.convs.has(this.key(t, p)) ? [[p, this.convs.get(this.key(t, p))!] as const] : [])));
  }
  async updateConversation(t: string, p: string, data: Partial<Omit<ConversationState, "phone">>) {
    const c = this.convs.get(this.key(t, p)) ?? { phone: p, status: "open" as const, assignedToUserId: null, handoffReason: null, aiPausedUntil: null, lastInboundAt: null };
    const next = { ...c, ...data };
    this.convs.set(this.key(t, p), next);
    return next;
  }
}

class FakeMessenger implements AgentMessenger {
  sent: { to: string; text: string }[] = [];
  connected = true;
  constructor(private readonly store: MemoryAgentStore) {}
  async connection() {
    return this.connected ? { token: "t", phoneNumberId: "p" } : null;
  }
  async sendText(_c: unknown, to: string, text: string) {
    this.sent.push({ to, text });
    return { ok: true, messageId: `wamid.${this.sent.length}` };
  }
  async record(m: { tenantId: string; phone: string; body: string }) {
    this.store.messages.push({ tenantId: m.tenantId, phone: m.phone, dir: "OUT", kind: "ai", text: m.body, at: new Date() });
  }
}

function setup(balance = 10) {
  const store = new MemoryAgentStore();
  const messenger = new FakeMessenger(store);
  const responder = new FakeAgentResponder();
  const creditStore = new MemoryCredits({ t1: { balance, isPlatformOwner: false }, t2: { balance: 10, isPlatformOwner: false } });
  const credits = new CreditService(creditStore);
  const service = new AiAgentService(store, messenger, responder, credits);
  return { store, messenger, responder, creditStore, service };
}

const inbound = (store: MemoryAgentStore, text: string, phone = "97455550001", tenantId = "t1") => {
  store.messages.push({ tenantId, phone, dir: "IN", kind: "text", text, at: new Date() });
  return { phone, name: "Sara", text, type: "text" };
};

describe("AiAgentService", () => {
  it("off by default → the normal bot answers (skipped), but the conversation is tracked", async () => {
    const { store, service, messenger } = setup();
    expect(await service.handleInbound("t1", inbound(store, "hi"))).toBe("skipped");
    expect(messenger.sent).toHaveLength(0);
    expect(store.convs.get("t1:97455550001")?.lastInboundAt).toBeInstanceOf(Date);
  });

  it("enabled: replies from the business data, charges 1 credit, history excludes the new message", async () => {
    const { store, service, messenger, responder, creditStore } = setup();
    await service.saveSettings("t1", { enabled: true });
    inbound(store, "earlier question");
    expect(await service.handleInbound("t1", inbound(store, "how much is karak?"))).toBe("replied");
    expect(messenger.sent[0].text).toContain("Karak is QAR 5.00");
    expect(messenger.sent[0].text).toContain("https://x.test/menu/karak");
    expect(creditStore.tenants.t1.balance).toBe(9);
    expect(creditStore.log[0]).toMatchObject({ reason: "AI_AGENT", amount: -1 });
    const call = responder.calls[0];
    expect(call.message).toBe("how much is karak?");
    expect(call.history.map((h) => h.text)).toEqual(["earlier question"]);
  });

  it("customer asks for a person → reply + conversation marked handoff, then silence (no bot either)", async () => {
    const { store, service, messenger } = setup();
    await service.saveSettings("t1", { enabled: true });
    expect(await service.handleInbound("t1", inbound(store, "I want to talk to a human"))).toBe("replied");
    expect(store.convs.get("t1:97455550001")).toMatchObject({ status: "handoff", handoffReason: "Customer asked for a person" });
    expect(await service.handleInbound("t1", inbound(store, "hello??"))).toBe("human");
    expect(messenger.sent).toHaveLength(1);
    // رجوع الموظف الذكي من الشاشة
    await service.updateConversation("t1", "97455550001", { resumeAi: true });
    expect(await service.handleInbound("t1", inbound(store, "karak price"))).toBe("replied");
  });

  it("a staff reply pauses the assistant on that conversation", async () => {
    const { store, service, messenger } = setup();
    await service.saveSettings("t1", { enabled: true });
    await service.humanReplied("t1", "97455550001");
    expect(await service.handleInbound("t1", inbound(store, "thanks"))).toBe("human");
    expect(messenger.sent).toHaveLength(0);
  });

  it("no credits → nothing charged, normal bot answers; provider failure → credit refunded", async () => {
    const zero = setup(0);
    await zero.service.saveSettings("t1", { enabled: true });
    expect(await zero.service.handleInbound("t1", inbound(zero.store, "hi"))).toBe("skipped");
    expect(zero.messenger.sent).toHaveLength(0);

    const { store, service, responder, creditStore, messenger } = setup(5);
    await service.saveSettings("t1", { enabled: true });
    responder.failNext = new Error("Google busy");
    expect(await service.handleInbound("t1", inbound(store, "hi"))).toBe("skipped");
    expect(creditStore.tenants.t1.balance).toBe(5);
    expect(messenger.sent).toHaveLength(0);
  });

  it("too many replies in an hour → handed to a person instead of burning credits", async () => {
    const { store, service, messenger } = setup(50);
    await service.saveSettings("t1", { enabled: true, maxRepliesPerHour: 2 });
    expect(await service.handleInbound("t1", inbound(store, "a"))).toBe("replied");
    expect(await service.handleInbound("t1", inbound(store, "b"))).toBe("replied");
    expect(await service.handleInbound("t1", inbound(store, "c"))).toBe("human");
    expect(store.convs.get("t1:97455550001")?.status).toBe("handoff");
    expect(messenger.sent).toHaveLength(2);
  });

  it("skips non-text messages, paused accounts and a disconnected WhatsApp", async () => {
    const { store, service, messenger } = setup();
    await service.saveSettings("t1", { enabled: true });
    expect(await service.handleInbound("t1", { phone: "97455550002", name: null, text: "[image]", type: "image" })).toBe("skipped");
    store.active = false;
    expect(await service.handleInbound("t1", inbound(store, "hi", "97455550003"))).toBe("skipped");
    store.active = true;
    messenger.connected = false;
    expect(await service.handleInbound("t1", inbound(store, "hi", "97455550004"))).toBe("skipped");
    expect(messenger.sent).toHaveLength(0);
  });

  it("settings are validated and per company; test mode charges but sends nothing", async () => {
    const { service, messenger, creditStore } = setup();
    const saved = await service.saveSettings("t1", { enabled: true, dialect: "qatari", knowledge: "x".repeat(7000), maxRepliesPerHour: 99 });
    expect(saved).toMatchObject({ enabled: true, dialect: "qatari", maxRepliesPerHour: 30 });
    expect(saved.knowledge.length).toBe(6000);
    expect((await service.getSettings("t2")).enabled).toBe(false);
    const out = await service.test("t1", "u1", "karak?");
    expect(out.reply).toContain("[qatari]");
    expect(out.balance).toBe(9);
    expect(messenger.sent).toHaveLength(0);
    expect(creditStore.log[0].reason).toBe("AI_AGENT_TEST");
    await expect(service.test("t1", "u1", "  ")).rejects.toMatchObject({ status: 400 });
  });

  it("can't be switched on when the platform has no AI provider", async () => {
    const store = new MemoryAgentStore();
    const service = new AiAgentService(store, new FakeMessenger(store), null, new CreditService(new MemoryCredits({})));
    await expect(service.saveSettings("t1", { enabled: true })).rejects.toMatchObject({ status: 503 });
  });
});

describe("agent prompt + reply cleaning", () => {
  it("prompt carries only the given facts, links and history", () => {
    const p = buildAgentPrompt({ business: business({ services: [{ name: "Haircut", price: "QAR 50.00" }], bookingHours: "9:00 – 21:00" }), history: [{ from: "customer", text: "hi" }], message: "price?", customerName: "Sara" });
    expect(p).toContain("Karak — QAR 5.00 [Drinks]");
    expect(p).toContain("Haircut — QAR 50.00");
    expect(p).toContain("Delivery in Doha only.");
    expect(p).toContain("Menu / order link: https://x.test/menu/karak");
    expect(p).toContain("Customer: hi");
    expect(p).toContain("(Sara)");
  });
  it("empty business → told to hand off", () => {
    expect(buildAgentPrompt({ business: business({ menu: [], knowledge: "", links: { booking: null, menu: null, links: null } }), history: [], message: "x", customerName: null })).toContain("has not added any details");
  });
  it("cleans leaked JSON / code from the reply", () => {
    expect(cleanAgentReply({ reply: 'Karak is 5 QAR ```json {"a":1}', handoff: false, reason: "" })).toEqual({ reply: "Karak is 5 QAR", handoff: false, reason: "", book: null });
    expect(cleanAgentReply({ reply: "```", handoff: true, reason: "" })).toBeNull();
  });
});
