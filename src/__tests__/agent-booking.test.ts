import { describe, expect, it } from "vitest";
import { freeDays, matchServices, type AgentBooker, type AgentBookResult } from "../modules/whatsapp/agent-booking";
import { AiAgentService, bookingProblemText } from "../modules/whatsapp/ai-agent.service";
import { DEFAULT_AGENT_SETTINGS, type AgentMessenger, type AgentSettings, type AiAgentStore, type ConversationState } from "../modules/whatsapp/ai-agent.repository";
import type { AgentBookingInfo, AgentBookingRequest, AgentBusinessContext } from "../modules/ai/agent-types";
import { bookingRequestOf } from "../modules/ai/agent-types";
import { buildAgentPrompt } from "../modules/ai/agent.prompts";
import { FakeAgentResponder } from "../modules/ai/agent-responders";
import { CreditService } from "../modules/credits/credit.service";
import { MemoryCredits } from "./helpers/ai-memory-stores";

describe("free booking times", () => {
  const base = { todayKey: "2026-11-05", openHour: 9, closeHour: 13, disabledHours: [11], resourceIds: ["r1", "r2"], days: 2 };
  it("today skips past hours; a slot is free while one resource is free; disabled hours are out", () => {
    const days = freeDays({
      ...base,
      currentHour: 9,
      taken: [
        { resourceId: "r1", dateKey: "2026-11-05", hour: 10 },
        { resourceId: "r1", dateKey: "2026-11-06", hour: 9 },
        { resourceId: "r2", dateKey: "2026-11-06", hour: 9 },
      ],
    });
    expect(days).toEqual([
      { date: "2026-11-05", weekday: "Thursday", hours: [10, 12] },
      { date: "2026-11-06", weekday: "Friday", hours: [10, 12] },
    ]);
  });
  it("no resources = no times", () => {
    expect(freeDays({ ...base, resourceIds: [], currentHour: 0, taken: [] })).toEqual([]);
  });
  it("service names match the saved names loosely", () => {
    expect(matchServices([" haircut", "BEARD  trim", "nope"], ["Haircut", "Beard trim"])).toEqual(["Haircut", "Beard trim"]);
  });
  it("booking request is only taken when the date/hour are real", () => {
    expect(bookingRequestOf({ date: "", hour: -1, services: [], name: "" })).toBeNull();
    expect(bookingRequestOf({ date: "2026-11-06", hour: 24, services: [], name: "" })).toBeNull();
    expect(bookingRequestOf({ date: "2026-11-06", hour: 10, services: [" Haircut "], name: " Sara " })).toEqual({ date: "2026-11-06", hour: 10, services: ["Haircut"], name: "Sara" });
    expect(bookingRequestOf(undefined)).toBeNull();
  });
});

const info = (over: Partial<AgentBookingInfo> = {}): AgentBookingInfo => ({ canBookInChat: true, needsService: false, days: [{ date: "2026-11-06", weekday: "Friday", hours: [10, 11] }], ...over });

class Store implements AiAgentStore {
  s: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, enabled: true };
  convs = new Map<string, ConversationState>();
  async settings() {
    return this.s;
  }
  async saveSettings(_t: string, v: AgentSettings) {
    this.s = v;
    return v;
  }
  async businessContext(): Promise<AgentBusinessContext> {
    return {
      name: "Studio",
      industry: "SERVICES",
      currency: "QAR",
      knowledge: "",
      menu: [],
      services: [{ name: "Photo session", price: "QAR 1,200.00" }],
      bookingHours: "9:00 – 13:00",
      links: { booking: "https://x.test/book/s", menu: null, links: null },
      dialect: "auto",
      booking: null,
    };
  }
  async accountActive() {
    return true;
  }
  async history() {
    return [];
  }
  async aiRepliesSince() {
    return 0;
  }
  async touchInbound(_t: string, p: string) {
    return this.convs.get(p) ?? { phone: p, status: "open" as const, assignedToUserId: null, handoffReason: null, aiPausedUntil: null, lastInboundAt: null };
  }
  async conversations() {
    return new Map();
  }
  async updateConversation(_t: string, p: string, d: Partial<Omit<ConversationState, "phone">>) {
    const next = { ...(await this.touchInbound("", p)), ...d };
    this.convs.set(p, next);
    return next;
  }
}

class Messenger implements AgentMessenger {
  sent: string[] = [];
  async connection() {
    return { token: "t", phoneNumberId: "p" };
  }
  async sendText(_c: unknown, _to: string, text: string) {
    this.sent.push(text);
    return { ok: true, messageId: "w" };
  }
  async record() {}
}

class FakeBooker implements AgentBooker {
  calls: (AgentBookingRequest & { phone: string })[] = [];
  constructor(public i: AgentBookingInfo | null, public result: AgentBookResult = { ok: true, bookingId: "b1", confirmationSent: true }) {}
  async info() {
    return this.i;
  }
  async book(_t: string, req: AgentBookingRequest & { phone: string }) {
    this.calls.push(req);
    return this.result;
  }
}

function setup(booker: FakeBooker) {
  const store = new Store();
  const messenger = new Messenger();
  const responder = new FakeAgentResponder();
  const service = new AiAgentService(store, messenger, responder, new CreditService(new MemoryCredits({ t1: { balance: 10, isPlatformOwner: false } })), booker);
  return { store, messenger, responder, service };
}

const emptyBiz = (booking: AgentBookingInfo): AgentBusinessContext => ({ name: "S", industry: "x", currency: "QAR", knowledge: "", menu: [], services: [], bookingHours: null, links: { booking: null, menu: null, links: null }, dialect: "auto", booking });

describe("AI assistant books in the chat", () => {
  it("gets the free times; a confirmed booking is made and the booking confirmation replaces the AI text", async () => {
    const booker = new FakeBooker(info());
    const { service, messenger, responder } = setup(booker);
    expect(await service.handleInbound("t1", { phone: "97455550001", name: "Sara", text: "book 2026-11-06 10", type: "text" })).toBe("replied");
    expect(responder.calls[0].business.booking?.days[0].hours).toEqual([10, 11]);
    expect(booker.calls[0]).toMatchObject({ date: "2026-11-06", hour: 10, services: ["Photo session"], name: "Sara", phone: "97455550001" });
    expect(messenger.sent).toEqual([]);
  });

  it("booked but no WhatsApp confirmation went out → the AI's own confirmation is sent", async () => {
    const booker = new FakeBooker(info(), { ok: true, bookingId: "b1", confirmationSent: false });
    const { service, messenger } = setup(booker);
    await service.handleInbound("t1", { phone: "97455550001", name: "Sara", text: "book", type: "text" });
    expect(messenger.sent).toEqual(["Booked for 2026-11-06 at 10:00 ✅"]);
  });

  it("slot taken → nearest free times in the customer's language, no handoff", async () => {
    const booker = new FakeBooker(info(), { ok: false, error: "slot_not_free" });
    const { service, messenger, store } = setup(booker);
    await service.handleInbound("t1", { phone: "97455550001", name: "Sara", text: "احجزلي book 2026-11-06 10", type: "text" });
    expect(messenger.sent[0]).toContain("للأسف الميعاد ده مش متاح");
    expect(messenger.sent[0]).toContain("2026-11-06: 10:00, 11:00");
    expect(store.convs.get("97455550001")?.status ?? "open").toBe("open");
  });

  it("unexpected booking error → apology + link and the chat goes to a person", async () => {
    const booker = new FakeBooker(info(), { ok: false, error: "This business hasn't set up a payment method yet." });
    const { service, messenger, store } = setup(booker);
    await service.handleInbound("t1", { phone: "97455550001", name: "Sara", text: "book", type: "text" });
    expect(messenger.sent[0]).toContain("https://x.test/book/s");
    expect(store.convs.get("97455550001")).toMatchObject({ status: "handoff" });
  });

  it("online payment needed → no booking from the chat", async () => {
    const booker = new FakeBooker(info({ canBookInChat: false }));
    const { service, messenger } = setup(booker);
    await service.handleInbound("t1", { phone: "97455550001", name: "Sara", text: "book", type: "text" });
    expect(booker.calls).toHaveLength(0);
    expect(messenger.sent).toHaveLength(1);
  });

  it("test mode shows the booking it would make but books nothing", async () => {
    const booker = new FakeBooker(info());
    const { service } = setup(booker);
    const out = await service.test("t1", "u1", "book");
    expect(out.wouldBook).toMatchObject({ date: "2026-11-06", hour: 10 });
    expect(booker.calls).toHaveLength(0);
  });

  it("prompt lists the free times and the rule", () => {
    const p = buildAgentPrompt({ business: emptyBiz(info({ needsService: true })), history: [], message: "hi", customerName: null });
    expect(p).toContain("You CAN book in this chat. The customer must pick at least one service");
    expect(p).toContain("- 2026-11-06 (Friday): 10:00, 11:00");
    expect(buildAgentPrompt({ business: emptyBiz(info({ canBookInChat: false })), history: [], message: "hi", customerName: null })).toContain("NOT possible");
  });

  it("problem texts", () => {
    expect(bookingProblemText({ ok: false, error: "service_needed" }, "hi", info(), null, ["A", "B"])).toBe("To finish the booking, please choose the service: A, B");
    expect(bookingProblemText({ ok: false, error: "slot_not_free" }, "hi", info({ days: [] }), "https://l", [])).toContain("You can check here: https://l");
  });
});
