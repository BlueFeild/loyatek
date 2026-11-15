import { describe, expect, it } from "vitest";
import { fillName, isOpenAt, localClock, nextAssignee } from "../modules/whatsapp/inbox-hours";
import { InboxToolsService, type InboxSettings, type InboxToolsStore, type QuickReply } from "../modules/whatsapp/inbox-tools.service";

const QA = "Asia/Qatar"; // UTC+3
const at = (iso: string) => new Date(iso);

describe("working hours", () => {
  const hours = { "0": [["09:00", "17:00"]] as [string, string][], "4": [["20:00", "02:00"]] as [string, string][] };
  it("reads the local day and time", () => {
    expect(localClock(at("2026-11-15T06:30:00Z"), QA)).toEqual({ day: 0, minute: 9 * 60 + 30 }); // Sunday 09:30 Doha
  });
  it("open inside, closed outside, closed on days without hours", () => {
    expect(isOpenAt(hours, QA, at("2026-11-15T06:30:00Z"))).toBe(true);
    expect(isOpenAt(hours, QA, at("2026-11-15T14:00:00Z"))).toBe(false); // 17:00 = closed
    expect(isOpenAt(hours, QA, at("2026-11-16T07:00:00Z"))).toBe(false); // Monday
  });
  it("a shift past midnight stays open into the next day", () => {
    expect(isOpenAt(hours, QA, at("2026-11-19T18:00:00Z"))).toBe(true); // Thu 21:00
    expect(isOpenAt(hours, QA, at("2026-11-19T22:30:00Z"))).toBe(true); // Fri 01:30
    expect(isOpenAt(hours, QA, at("2026-11-19T23:30:00Z"))).toBe(false); // Fri 02:30
  });
  it("no hours saved = always open", () => {
    expect(isOpenAt(null, QA, new Date())).toBe(true);
    expect(isOpenAt({ "1": [] }, QA, new Date())).toBe(true);
  });
  it("round robin + name fill", () => {
    expect(nextAssignee(["a", "b", "c"], null)).toBe("a");
    expect(nextAssignee(["a", "b", "c"], "c")).toBe("a");
    expect(nextAssignee(["a", "b"], "x")).toBe("a");
    expect(nextAssignee([], "a")).toBeNull();
    expect(fillName("Hi {name}, we're closed", "")).toBe("Hi, we're closed");
    expect(fillName("أهلًا {name}، إحنا قافلين", "سارة")).toBe("أهلًا سارة، إحنا قافلين");
  });
});

class MemStore implements InboxToolsStore {
  qr: QuickReply[] = [];
  s: InboxSettings = { autoAssign: "off", assignUserIds: [], awayEnabled: false, awayText: "", hours: null, timezone: "Asia/Qatar", awayEveryHours: 12 };
  last: string | null = null;
  assigned = new Map<string, string>();
  away = new Map<string, Date>();
  active = ["u1", "u2", "u3"];
  async quickReplies() { return this.qr; }
  async quickReply(_t: string, id: string) { return this.qr.find((q) => q.id === id) ?? null; }
  async shortcutTaken(_t: string, sc: string, except?: string) { return this.qr.some((q) => q.shortcut === sc && q.id !== except); }
  async createQuickReply(_t: string, d: Omit<QuickReply, "id">) { const q = { id: "q" + this.qr.length, ...d }; this.qr.push(q); return q; }
  async updateQuickReply(id: string, d: Partial<QuickReply>) { const q = this.qr.find((x) => x.id === id)!; Object.assign(q, d); return q; }
  async deleteQuickReply(id: string) { this.qr = this.qr.filter((q) => q.id !== id); }
  async settings() { return { ...this.s }; }
  async saveSettings(_t: string, s: InboxSettings) { this.s = s; return s; }
  async activeUserIds(_t: string, ids: string[]) { return ids.filter((i) => this.active.includes(i)); }
  async companyTimezone() { return null; }
  async assignRoundRobin(_t: string, phone: string, pick: (a: string[], l: string | null) => string | null) {
    if (this.assigned.has(phone)) return null;
    const id = pick(this.s.assignUserIds.filter((i) => this.active.includes(i)), this.last);
    if (!id) return null;
    this.assigned.set(phone, id);
    this.last = id;
    return id;
  }
  async claimAway(_t: string, phone: string, now: Date, h: number) {
    const prev = this.away.get(phone);
    if (prev && now.getTime() - prev.getTime() < h * 3600_000) return false;
    this.away.set(phone, now);
    return true;
  }
}

describe("InboxToolsService", () => {
  const setup = (now = at("2026-11-16T19:00:00Z")) => {
    const store = new MemStore();
    const sent: string[] = [];
    const svc = new InboxToolsService(store, { sendText: async (_t, _p, _n, text) => (sent.push(text), true) }, () => now);
    return { store, sent, svc };
  };

  it("quick replies: shortcut cleaned, duplicates refused, other company's id = 404 path", async () => {
    const { svc } = setup();
    const q = await svc.createQuickReply("t", { shortcut: "/Prices List", title: "Prices", body: "Our prices…" });
    expect(q.shortcut).toBe("prices-list");
    await expect(svc.createQuickReply("t", { shortcut: "prices-list", title: "x", body: "y" })).rejects.toMatchObject({ status: 409 });
    await expect(svc.createQuickReply("t", { shortcut: "ok", title: "x", body: "" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateQuickReply("t", "missing", { title: "z" })).rejects.toMatchObject({ status: 404 });
  });

  it("settings: needs people for round robin, hours + text for away, known users only", async () => {
    const { svc } = setup();
    await expect(svc.saveSettings("t", { autoAssign: "round_robin" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.saveSettings("t", { autoAssign: "round_robin", assignUserIds: ["00000000-0000-4000-8000-000000000001"] })).rejects.toThrow(/own company/);
    await expect(svc.saveSettings("t", { awayEnabled: true, awayText: "closed" })).rejects.toThrow(/working hours/);
    await expect(svc.saveSettings("t", { timezone: "Mars/Base" })).rejects.toThrow(/time zone/);
  });

  it("shares new chats in turn and skips people who were switched off", async () => {
    const { store, svc } = setup();
    store.s = { ...store.s, autoAssign: "round_robin", assignUserIds: ["u1", "u2", "u3"] };
    const who = [];
    for (const p of ["a", "b", "c", "d"]) who.push((await svc.afterInbound("t", { phone: p, name: null, autoReplied: false })).assignedTo);
    expect(who).toEqual(["u1", "u2", "u3", "u1"]);
    expect((await svc.afterInbound("t", { phone: "a", name: null, autoReplied: false })).assignedTo).toBeNull(); // already has someone
    store.active = ["u1", "u3"]; // u2 stopped
    expect((await svc.afterInbound("t", { phone: "e", name: null, autoReplied: false })).assignedTo).toBe("u3");
    store.last = "u2"; // the last one was u2, who is now off → continue after him
    expect((await svc.afterInbound("t", { phone: "f", name: null, autoReplied: false })).assignedTo).toBe("u3");
  });

  it("away message: only outside hours, once per window, not when the AI already answered", async () => {
    const { store, sent, svc } = setup(at("2026-11-16T19:00:00Z")); // Monday 22:00 Doha
    store.s = { ...store.s, awayEnabled: true, awayText: "Hi {name}, we're closed — back at 9.", hours: { "1": [["09:00", "17:00"]] } };
    expect((await svc.afterInbound("t", { phone: "a", name: "Sara", autoReplied: true })).awaySent).toBe(false);
    expect((await svc.afterInbound("t", { phone: "a", name: "Sara", autoReplied: false })).awaySent).toBe(true);
    expect((await svc.afterInbound("t", { phone: "a", name: "Sara", autoReplied: false })).awaySent).toBe(false);
    expect(sent).toEqual(["Hi Sara, we're closed — back at 9."]);
    const open = setup(at("2026-11-16T08:00:00Z")); // Monday 11:00 Doha
    open.store.s = store.s;
    expect((await open.svc.afterInbound("t", { phone: "a", name: null, autoReplied: false })).awaySent).toBe(false);
  });
});
