import { describe, expect, it } from "vitest";
import { SequenceService, decide, nextStepAt, type EnrollmentRow, type SequenceRow, type SequenceStore } from "../modules/whatsapp/sequence.service";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function fakeStore(seq: SequenceRow, due: EnrollmentRow[], opts: { optedOut?: string[]; replied?: string[] } = {}) {
  const finished: { id: string; data: Record<string, unknown> }[] = [];
  const enrolled: { phone: string; status: string; nextAt: Date | null }[] = [];
  const store: SequenceStore = {
    list: async () => [seq],
    get: async () => seq,
    create: async () => seq,
    update: async (_t, _i, d) => Object.assign(seq, d),
    remove: async () => {},
    templates: async (_t, ids) => ids.map((id) => ({ id, name: "tpl_" + id.slice(0, 1), status: "APPROVED", bodyText: "Hi {{1}}" })),
    counts: async () => new Map(),
    people: async () => [],
    taggedNotEnrolled: async () => (seq.triggerTag ? [{ phone: "97455550009", name: "New" }] : []),
    enroll: async (_s, people, status, nextAt) => {
      people.forEach((p) => enrolled.push({ phone: p.phone, status, nextAt }));
      return people.length;
    },
    enabledWithTag: async () => (seq.enabled && seq.triggerTag ? [seq] : []),
    claimDue: async () => due,
    finishStep: async (id, data) => {
      finished.push({ id, data });
    },
    stopOne: async () => true,
    contact: async (_t, phone) => ({ optedOut: (opts.optedOut ?? []).includes(phone) }),
    repliedSince: async (_t, phone) => (opts.replied ?? []).includes(phone),
  };
  return { store, finished, enrolled };
}

const seqBase = (): SequenceRow => ({
  id: "s1",
  tenantId: "t1",
  name: "Welcome",
  enabled: true,
  triggerTag: "new-lead",
  stopOnReply: true,
  steps: [
    { delayMinutes: 0, templateId: T1 },
    { delayMinutes: 1440, templateId: T2 },
  ],
  createdAt: new Date(),
});
const enr = (id: string, phone: string, stepIndex = 0, lastError: string | null = null): EnrollmentRow => ({ id, tenantId: "t1", sequenceId: "s1", phone, name: "Sara", stepIndex, status: "ACTIVE", enrolledAt: new Date(0), lastError });

describe("WhatsApp sequences (drip)", () => {
  it("computes when the next message goes out", () => {
    const from = new Date("2026-11-15T10:00:00Z");
    expect(nextStepAt(seqBase().steps, 1, from)?.toISOString()).toBe("2026-11-16T10:00:00.000Z");
    expect(nextStepAt(seqBase().steps, 2, from)).toBeNull();
  });

  it("decides send / stop / done / pause", () => {
    const s = seqBase();
    expect(decide(s, { stepIndex: 0 }, { optedOut: false }, false)).toEqual({ action: "send" });
    expect(decide(s, { stepIndex: 0 }, { optedOut: true }, false)).toMatchObject({ action: "stop" });
    expect(decide(s, { stepIndex: 0 }, null, true)).toMatchObject({ action: "stop", reason: "Replied" });
    expect(decide({ ...s, stopOnReply: false }, { stepIndex: 0 }, null, true)).toEqual({ action: "send" });
    expect(decide(s, { stepIndex: 2 }, null, false)).toEqual({ action: "done" });
    expect(decide({ ...s, enabled: false }, { stepIndex: 0 }, null, false)).toEqual({ action: "pause" });
    expect(decide(null, { stepIndex: 0 }, null, false)).toMatchObject({ action: "stop" });
  });

  it("enrolls tagged contacts and sends due messages, stopping on reply/opt-out", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    const seq = seqBase();
    const { store, finished, enrolled } = fakeStore(seq, [enr("a", "97455550001"), enr("b", "97455550002"), enr("c", "97455550003", 1)], { replied: ["97455550002"] });
    const sent: string[] = [];
    const svc = new SequenceService(store, { send: async (_t, phone, _n, tpl) => (sent.push(phone + ":" + tpl), { ok: true }) }, () => now);
    const r = await svc.runDue();
    expect(r).toEqual({ enrolled: 1, sent: 2, stopped: 1, failed: 0 });
    expect(enrolled[0]).toMatchObject({ phone: "97455550009", status: "ACTIVE" });
    expect(sent).toEqual([`97455550001:${T1}`, `97455550003:${T2}`]);
    const a = finished.find((f) => f.id === "a")!.data;
    expect(a).toMatchObject({ stepIndex: 1, status: "ACTIVE" });
    expect((a.nextAt as Date).toISOString()).toBe("2026-11-16T10:00:00.000Z");
    expect(finished.find((f) => f.id === "b")!.data).toMatchObject({ status: "STOPPED", stopReason: "Replied" });
    expect(finished.find((f) => f.id === "c")!.data).toMatchObject({ stepIndex: 2, status: "DONE", nextAt: null });
  });

  it("retries a failed send once, then stops", async () => {
    const now = new Date();
    const seq = seqBase();
    const { store, finished } = fakeStore(seq, [enr("a", "97455550001"), enr("b", "97455550002", 0, "earlier failure")]);
    const svc = new SequenceService(store, { send: async () => ({ ok: false, error: "Meta said no" }) }, () => now);
    const r = await svc.runDue();
    expect(r.failed).toBe(2);
    expect(finished.find((f) => f.id === "a")!.data).toMatchObject({ status: "ACTIVE", lastError: "Meta said no" });
    expect(finished.find((f) => f.id === "b")!.data).toMatchObject({ status: "STOPPED" });
  });

  it("refuses to turn on without messages or with an unapproved template", async () => {
    const seq = { ...seqBase(), enabled: false, steps: [] };
    const { store } = fakeStore(seq, []);
    const svc = new SequenceService(store, { send: async () => ({ ok: true }) });
    await expect(svc.update("t1", "s1", { enabled: true })).rejects.toThrow(/at least one message/);
    store.templates = async (_t, ids) => ids.map((id) => ({ id, name: "promo", status: "PENDING", bodyText: "Hi" }));
    await expect(svc.update("t1", "s1", { enabled: true, steps: [{ delayMinutes: 0, templateId: T1 }] })).rejects.toThrow(/isn't approved/);
    store.templates = async (_t, ids) => ids.map((id) => ({ id, name: "promo", status: "APPROVED", bodyText: "Hi {{1}} {{2}}" }));
    await expect(svc.update("t1", "s1", { steps: [{ delayMinutes: 0, templateId: T1 }] })).rejects.toThrow(/more than one blank/);
  });

  it("marks people already tagged as skipped when the owner says so", async () => {
    const seq = { ...seqBase(), enabled: false };
    const { store, enrolled } = fakeStore(seq, []);
    const svc = new SequenceService(store, { send: async () => ({ ok: true }) });
    await svc.update("t1", "s1", { enabled: true, includeExisting: false });
    expect(enrolled).toEqual([{ phone: "97455550009", status: "SKIPPED", nextAt: null }]);
  });
});
