import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { hashApprovalToken, nextOccurrence, SocialPlannerService } from "../modules/social/social-planner.service";
import type { ApprovalView, PlannerPost, PlannerStore } from "../modules/social/social-planner.repository";
import { buildReport, previousMonth } from "../modules/social/social-report.service";
import { IntegrationsService, hashApiKey } from "../modules/integrations/integrations.service";
import type { ApiKeyView, IntegrationsStore, WebhookRow } from "../modules/integrations/integrations.repository";
import { assertSafeUrl, isPrivateAddress, signWebhook } from "../modules/integrations/webhook-signing";
import { buildFacets, graphemeLength } from "../modules/social/bluesky.gateway";
import { SocialFlowService, type SocialFlowStore } from "../modules/social/social-flow.service";
import type { FlowDef, FlowSessionState } from "../modules/whatsapp/flow-engine";
import { parseSocialWebhook } from "../modules/social/social-webhook.parser";

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const at = (s: string) => new Date(s);

describe("recurring posts — next occurrence", () => {
  it("daily / weekly add whole days", () => {
    expect(nextOccurrence(at("2026-11-05T09:00:00Z"), "DAILY").toISOString()).toBe("2026-11-06T09:00:00.000Z");
    expect(nextOccurrence(at("2026-11-05T09:00:00Z"), "WEEKLY").toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });
  it("monthly keeps the day, or the last day of a shorter month", () => {
    expect(nextOccurrence(at("2026-01-31T18:30:00Z"), "MONTHLY").toISOString()).toBe("2026-02-28T18:30:00.000Z");
    expect(nextOccurrence(at("2028-01-31T18:30:00Z"), "MONTHLY").toISOString()).toBe("2028-02-29T18:30:00.000Z");
    expect(nextOccurrence(at("2026-12-15T07:00:00Z"), "MONTHLY").toISOString()).toBe("2027-01-15T07:00:00.000Z");
  });
});

class MemoryPlanner implements PlannerStore {
  posts = new Map<string, PlannerPost & { approvalTokenHash?: string | null; approvalNote?: string | null; approvalBy?: string | null }>();
  seq = 0;
  add(p: Partial<PlannerPost> & { id: string }) {
    this.posts.set(p.id, { tenantId: "t1", createdById: null, caption: "hi", mediaId: null, status: "SCHEDULED", scheduledAt: null, publishedAt: null, options: null, repeatEvery: null, repeatUntil: null, seriesId: null, approvalStatus: null, accountIds: ["a1"], ...p });
  }
  async post(tenantId: string, id: string) {
    const p = this.posts.get(id);
    return p && p.tenantId === tenantId ? { ...p } : null;
  }
  async reschedule(tenantId: string, id: string, scheduledAt: Date) {
    const p = this.posts.get(id);
    if (!p || p.tenantId !== tenantId || !["DRAFT", "SCHEDULED", "FAILED"].includes(p.status)) return false;
    p.scheduledAt = scheduledAt;
    return true;
  }
  async copy(p: Omit<PlannerPost, "id" | "publishedAt">) {
    const id = `copy-${++this.seq}`;
    this.posts.set(id, { ...p, id, publishedAt: null });
    return id;
  }
  async occurrenceExists(seriesId: string, scheduledAt: Date) {
    return [...this.posts.values()].some((p) => p.seriesId === seriesId && p.scheduledAt?.getTime() === scheduledAt.getTime());
  }
  async setApproval(tenantId: string, id: string, a: { status: string | null; tokenHash?: string | null }) {
    const p = this.posts.get(id);
    if (!p || p.tenantId !== tenantId || !["DRAFT", "SCHEDULED", "FAILED"].includes(p.status)) return false;
    p.approvalStatus = a.status;
    if (a.tokenHash !== undefined) p.approvalTokenHash = a.tokenHash;
    return true;
  }
  async approvalByToken(hash: string): Promise<ApprovalView | null> {
    const p = [...this.posts.values()].find((x) => x.approvalTokenHash === hash);
    if (!p) return null;
    return { id: p.id, tenantId: p.tenantId, caption: p.caption, status: p.status, scheduledAt: p.scheduledAt, approvalStatus: p.approvalStatus, approvalNote: p.approvalNote ?? null, approvalBy: p.approvalBy ?? null, approvalAt: null, media: null, targets: [], business: "Cafe" };
  }
  async decide(hash: string, d: { status: "APPROVED" | "CHANGES"; note: string | null; by: string | null }) {
    const p = [...this.posts.values()].find((x) => x.approvalTokenHash === hash);
    if (!p || !p.approvalStatus || !["DRAFT", "SCHEDULED", "FAILED"].includes(p.status)) return false;
    Object.assign(p, { approvalStatus: d.status, approvalNote: d.note, approvalBy: d.by });
    return true;
  }
}

function planner(now = at("2026-11-05T10:00:00Z")) {
  const store = new MemoryPlanner();
  const emails: { to: string; text: string }[] = [];
  const svc = new SocialPlannerService(store, { frontendBaseUrl: () => "https://app.test", publicMediaUrl: (k) => `https://api.test/m/${k}`, sendEmail: async (to, _s, text) => void emails.push({ to, text }), now: () => now });
  return { store, svc, emails };
}

describe("social planner", () => {
  it("creates the next occurrence once, in the future, and stops at repeatUntil", async () => {
    const { store, svc } = planner(at("2026-11-05T10:00:00Z"));
    store.add({ id: "p1", status: "PUBLISHED", scheduledAt: at("2026-11-01T09:00:00Z"), repeatEvery: "DAILY", repeatUntil: at("2026-11-07T00:00:00Z") });
    const id = await svc.afterPublish({ id: "p1", tenantId: "t1", status: "PUBLISHED" });
    expect(id).toBeTruthy();
    const next = store.posts.get(id!)!;
    // اتخطّى الأيام اللي فاتت (السيرفر كان واقف) ونزل على أول ميعاد جاي
    expect(next.scheduledAt!.toISOString()).toBe("2026-11-06T09:00:00.000Z");
    expect(next.status).toBe("SCHEDULED");
    expect(next.seriesId).toBe("p1");
    expect(await svc.afterPublish({ id: "p1", tenantId: "t1", status: "PUBLISHED" })).toBeNull();
    // بعد كده الميعاد اللي بعده (7 نوفمبر 9 الصبح) بعد repeatUntil → السلسلة خلصت
    store.posts.get(id!)!.status = "PUBLISHED";
    expect(await svc.afterPublish({ id: id!, tenantId: "t1", status: "PUBLISHED" })).toBeNull();
  });

  it("a series keeps going after a failed occurrence and keeps the client approval", async () => {
    const { store, svc } = planner();
    store.add({ id: "p1", status: "FAILED", scheduledAt: at("2026-11-05T09:00:00Z"), repeatEvery: "WEEKLY", approvalStatus: "APPROVED" });
    const id = await svc.afterPublish({ id: "p1", tenantId: "t1", status: "FAILED" });
    expect(store.posts.get(id!)!.approvalStatus).toBe("APPROVED");
    expect(store.posts.get(id!)!.scheduledAt!.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  it("reschedule: past time refused for scheduled posts, allowed for drafts; other company = 404", async () => {
    const { store, svc } = planner();
    store.add({ id: "p1", status: "SCHEDULED", scheduledAt: at("2026-11-06T09:00:00Z") });
    store.add({ id: "d1", status: "DRAFT" });
    store.add({ id: "x1", tenantId: "t2", status: "SCHEDULED" });
    await expect(svc.reschedule("t1", "p1", at("2026-11-04T09:00:00Z"))).rejects.toThrow(/passed/);
    await svc.reschedule("t1", "p1", at("2026-11-08T09:00:00Z"));
    expect(store.posts.get("p1")!.scheduledAt!.toISOString()).toBe("2026-11-08T09:00:00.000Z");
    await svc.reschedule("t1", "d1", at("2026-11-01T09:00:00Z"));
    await expect(svc.reschedule("t1", "x1", at("2026-11-08T09:00:00Z"))).rejects.toThrow(/not found/i);
    store.posts.get("p1")!.status = "PUBLISHED";
    await expect(svc.reschedule("t1", "p1", at("2026-11-09T09:00:00Z"))).rejects.toThrow(/published/);
  });

  it("duplicate = a new draft without schedule, repeat or approval", async () => {
    const { store, svc } = planner();
    store.add({ id: "p1", status: "PUBLISHED", scheduledAt: at("2026-11-01T09:00:00Z"), repeatEvery: "DAILY", approvalStatus: "APPROVED", accountIds: ["a1", "a2"] });
    const { id } = await svc.duplicate("t1", "p1", "u1");
    const c = store.posts.get(id)!;
    expect([c.status, c.scheduledAt, c.repeatEvery, c.approvalStatus]).toEqual(["DRAFT", null, null, null]);
    expect(c.accountIds).toEqual(["a1", "a2"]);
  });

  it("client approval: link, approve, ask for changes (needs a note), old link stops working", async () => {
    const { store, svc, emails } = planner();
    store.add({ id: "p1", status: "SCHEDULED", scheduledAt: at("2026-11-06T09:00:00Z") });
    const first = await svc.requestApproval("t1", "p1", "client@example.com");
    expect(first.url).toMatch(/^https:\/\/app\.test\/approve\/[a-f0-9]{48}$/);
    expect(first.emailed).toBe(true);
    expect(emails[0].text).toContain(first.url);
    const token1 = first.url.split("/").pop()!;
    // بنخزن الـ hash بس
    expect(store.posts.get("p1")!.approvalTokenHash).toBe(hashApprovalToken(token1));
    expect((await svc.approvalPage(token1)).approvalStatus).toBe("PENDING");

    await expect(svc.decide(token1, { decision: "changes" })).rejects.toThrow(/what should be changed/);
    const changed = await svc.decide(token1, { decision: "changes", note: "Use the new price", name: "Sara" });
    expect([changed.approvalStatus, changed.approvalNote, changed.approvalBy]).toEqual(["CHANGES", "Use the new price", "Sara"]);

    const second = await svc.requestApproval("t1", "p1");
    const token2 = second.url.split("/").pop()!;
    await expect(svc.approvalPage(token1)).rejects.toThrow(/isn't valid/);
    expect((await svc.decide(token2, { decision: "approve" })).approvalStatus).toBe("APPROVED");
    await expect(svc.approvalPage("not-a-token")).rejects.toThrow(/isn't valid/);
    store.posts.get("p1")!.status = "PUBLISHED";
    await expect(svc.decide(token2, { decision: "approve" })).rejects.toThrow(/already published/);
  });
});

describe("monthly report numbers", () => {
  it("counts posts per platform, inbox, first-reply time and ads", () => {
    const m = (kind: string, direction: string, thread: string, minute: number, staff = false) => ({ kind, direction, threadKey: thread, accountId: "a1", sentById: staff ? "u1" : null, createdAt: new Date(Date.UTC(2026, 10, 2, 10, minute)) });
    const r = buildReport({
      messages: [m("COMMENT", "IN", "c1", 0), m("COMMENT", "OUT", "c1", 30, true), m("DM", "IN", "d1", 0), m("DM", "IN", "d1", 5), m("DM", "OUT", "d1", 10, true), m("DM", "IN", "d2", 0)],
      targets: [
        { platform: "FACEBOOK", accountName: "Page", status: "PUBLISHED", permalink: "https://fb/1", publishedAt: new Date(), caption: "Hello", mediaKind: "image" },
        { platform: "INSTAGRAM", accountName: "IG", status: "PUBLISHED", permalink: null, publishedAt: new Date(), caption: "Hello", mediaKind: "image" },
        { platform: "INSTAGRAM", accountName: "IG", status: "FAILED", permalink: null, publishedAt: null, caption: "x", mediaKind: null },
      ],
      ads: [
        { platform: "FACEBOOK", objective: "REACH", status: "ACTIVE", currency: "QAR", spend: 50.25, impressions: 1000, reach: 800, clicks: 20, conversations: 0 },
        { platform: "FACEBOOK", objective: "WHATSAPP", status: "COMPLETED", currency: "QAR", spend: 30, impressions: 500, reach: 400, clicks: 10, conversations: 7 },
      ],
      whatsapp: [{ direction: "IN", count: 12 }, { direction: "OUT", count: 9 }],
      previous: { published: 1, messagesIn: 2 },
    });
    expect(r.publishing.published).toBe(2);
    expect(r.publishing.failed).toBe(1);
    expect(r.publishing.byPlatform.INSTAGRAM).toEqual({ published: 1, failed: 1 });
    expect(r.inbox).toMatchObject({ comments: 1, messages: 3, replies: 2, conversations: 3, answeredPct: 67, avgFirstReplyMinutes: 20 });
    expect(r.ads).toMatchObject({ campaigns: 2, impressions: 1500, reach: 1200, clicks: 30, whatsappChats: 7, spendByCurrency: { QAR: 80.3 } });
    expect(r.whatsapp).toEqual({ received: 12, sent: 9 });
    expect(previousMonth(at("2026-01-03T00:00:00Z"))).toBe("2025-12");
  });
});

// ---------- API keys + webhooks ----------
class MemoryIntegrations implements IntegrationsStore {
  keys: (ApiKeyView & { tenantId: string; keyHash: string; revokedAt: Date | null })[] = [];
  hooks: WebhookRow[] = [];
  deliveries: { id: string; ok: boolean; status: number | null }[] = [];
  async createKey(k: { tenantId: string; name: string; prefix: string; keyHash: string }) {
    const row = { id: `k${this.keys.length + 1}`, name: k.name, prefix: k.prefix, lastUsedAt: null, createdAt: new Date(), tenantId: k.tenantId, keyHash: k.keyHash, revokedAt: null };
    this.keys.push(row);
    return row;
  }
  async listKeys(tenantId: string) {
    return this.keys.filter((k) => k.tenantId === tenantId && !k.revokedAt);
  }
  async revokeKey(tenantId: string, id: string, at: Date) {
    const k = this.keys.find((x) => x.id === id && x.tenantId === tenantId && !x.revokedAt);
    if (!k) return false;
    k.revokedAt = at;
    return true;
  }
  async keyByHash(hash: string) {
    return this.keys.find((k) => k.keyHash === hash) ?? null;
  }
  async touchKey() {}
  async countKeys(tenantId: string) {
    return (await this.listKeys(tenantId)).length;
  }
  async createWebhook(w: { tenantId: string; url: string; events: string[]; secret: string }) {
    const row: WebhookRow = { id: `w${this.hooks.length + 1}`, ...w, enabled: true, lastStatus: null, lastError: null, lastDeliveredAt: null, failCount: 0, createdAt: new Date() };
    this.hooks.push(row);
    return row;
  }
  async listWebhooks(tenantId: string) {
    return this.hooks.filter((h) => h.tenantId === tenantId);
  }
  async webhook(tenantId: string, id: string) {
    return this.hooks.find((h) => h.id === id && h.tenantId === tenantId) ?? null;
  }
  async updateWebhook(tenantId: string, id: string, patch: Partial<WebhookRow>) {
    const h = await this.webhook(tenantId, id);
    if (!h) return false;
    Object.assign(h, patch);
    return true;
  }
  async deleteWebhook(tenantId: string, id: string) {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter((h) => !(h.id === id && h.tenantId === tenantId));
    return this.hooks.length < before;
  }
  async subscribers(tenantId: string, event: string) {
    return this.hooks.filter((h) => h.tenantId === tenantId && h.enabled && h.events.includes(event));
  }
  async recordDelivery(id: string, r: { ok: boolean; status: number | null; disableAfter: number }) {
    this.deliveries.push({ id, ok: r.ok, status: r.status });
    const h = this.hooks.find((x) => x.id === id)!;
    h.failCount = r.ok ? 0 : h.failCount + 1;
    if (h.failCount >= r.disableAfter) h.enabled = false;
  }
}

describe("API keys", () => {
  it("key shown once, stored as hash, works until revoked, other format refused", async () => {
    const store = new MemoryIntegrations();
    const svc = new IntegrationsService(store);
    const k = await svc.createKey("t1", "u1", "Make");
    expect(k.key).toMatch(/^bf_live_[a-f0-9]{48}$/);
    expect(store.keys[0].keyHash).toBe(hashApiKey(k.key));
    expect(JSON.stringify(await svc.listKeys("t1"))).not.toContain(k.key);
    expect(await svc.authenticate(k.key)).toEqual({ tenantId: "t1", keyId: "k1" });
    expect(await svc.authenticate("bf_live_" + "0".repeat(48))).toBeNull();
    expect(await svc.authenticate("Bearer something")).toBeNull();
    await expect(svc.revokeKey("t2", "k1")).rejects.toThrow(/not found/i);
    await svc.revokeKey("t1", "k1");
    expect(await svc.authenticate(k.key)).toBeNull();
  });
});

describe("webhooks", () => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = "";
  it("private / non-https links are refused", async () => {
    expect(isPrivateAddress("10.0.0.5")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.20.1.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(assertSafeUrl("http://example.com/hook")).rejects.toThrow(/https/);
    await expect(assertSafeUrl("https://127.0.0.1/hook")).rejects.toThrow(/private/);
    await expect(assertSafeUrl("https://localhost/hook")).rejects.toThrow(/private/);
    await expect(assertSafeUrl("https://user:pw@8.8.8.8/hook")).rejects.toThrow(/password/);
    const svc = new IntegrationsService(new MemoryIntegrations());
    await expect(svc.createWebhook("t1", { url: "https://8.8.8.8/x", events: ["nope"] })).rejects.toThrow(/Unknown event/);
  });

  it("sends signed events only to subscribers, retries 5xx, not 4xx, and stops a dead link", async () => {
    const store = new MemoryIntegrations();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let answer = 200;
    const svc = new IntegrationsService(store, {
      post: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { status: answer };
      },
      later: (_ms, fn) => fn(),
    });
    const hook = await svc.createWebhook("t1", { url: "https://8.8.8.8/hook", events: ["booking.created"] });
    expect(hook.secret).toMatch(/^whsec_/);
    await svc.createWebhook("t2", { url: "https://8.8.4.4/other", events: ["booking.created"] });

    svc.emit("t1", "booking.created", { id: "b1" });
    svc.emit("t1", "order.created", { id: "o1" });
    await svc.idle();
    expect(calls).toHaveLength(1);
    const c = calls[0];
    const body = JSON.parse(c.body);
    expect(body).toMatchObject({ type: "booking.created", companyId: "t1", data: { id: "b1" } });
    const [tPart, vPart] = c.headers["X-BlueField-Signature"].split(",");
    expect(vPart.slice(3)).toBe(signWebhook(hook.secret, Number(tPart.slice(2)), c.body));

    calls.length = 0;
    answer = 503;
    svc.emit("t1", "booking.created", { id: "b2" });
    await svc.idle();
    expect(calls).toHaveLength(3); // الأولى + إعادتين

    calls.length = 0;
    answer = 400;
    svc.emit("t1", "booking.created", { id: "b3" });
    await svc.idle();
    expect(calls).toHaveLength(1);

    for (let i = 0; i < 20; i++) svc.emit("t1", "booking.created", { id: `x${i}` });
    await svc.idle();
    expect(store.hooks[0].enabled).toBe(false);
    const test = await svc.testWebhook("t1", "w1");
    expect(test.ok).toBe(false);
    await expect(svc.testWebhook("t2", "w1")).rejects.toThrow(/not found/i);
  });
});

describe("Bluesky", () => {
  it("counts graphemes and builds byte offsets for links and hashtags (Arabic too)", () => {
    expect(graphemeLength("👍🏽 مرحبا")).toBe(7);
    const text = "عرض اليوم #قهوة https://bf.co/menu";
    const facets = buildFacets(text);
    const bytes = Buffer.from(text, "utf8");
    const slice = (f: { index: { byteStart: number; byteEnd: number } }) => bytes.subarray(f.index.byteStart, f.index.byteEnd).toString("utf8");
    expect(facets.map(slice).sort()).toEqual(["#قهوة", "https://bf.co/menu"].sort());
    expect(facets.find((f) => f.features[0].$type.endsWith("#tag"))!.features[0].tag).toBe("قهوة");
  });
});

// ---------- السيناريوهات على انستجرام / ماسنجر ----------
const flow: FlowDef = {
  id: "f1",
  name: "Menu",
  enabled: true,
  keywords: ["menu"],
  startNodeId: "s",
  sortOrder: 0,
  channels: ["instagram"],
  nodes: [
    { id: "s", type: "message", text: "Hi {name}! Pick one", options: [{ label: "Prices", next: "p" }, { label: "Book", next: "q" }], saveAs: null, next: null, tag: null },
    { id: "p", type: "message", text: "Coffee 15 QAR", options: [], saveAs: null, next: null, tag: null },
    { id: "q", type: "question", text: "Your name?", options: [], saveAs: "name", next: null, tag: null },
  ],
};

class MemoryFlowStore implements SocialFlowStore {
  sessions = new Map<string, FlowSessionState>();
  completed: { key: string; answers: Record<string, string> }[] = [];
  staff = false;
  flows: FlowDef[] = [flow];
  async enabled() {
    return this.flows;
  }
  async session(_t: string, key: string) {
    return this.sessions.get(key) ?? null;
  }
  async saveSession(_t: string, key: string, s: { flowId: string; nodeId: string; answers: Record<string, string> } | null) {
    if (s) this.sessions.set(key, { ...s, updatedAt: new Date() });
    else this.sessions.delete(key);
  }
  async countStart() {}
  async complete(_t: string, r: { key: string; answers: Record<string, string> }) {
    this.completed.push(r);
  }
  async staffRepliedSince() {
    return this.staff;
  }
  async vars() {
    return { business: "Cafe" };
  }
}

describe("flows on Instagram / Messenger DMs", () => {
  const account = { id: "acc1", tenantId: "t1", name: "IG", status: "ACTIVE", platform: "INSTAGRAM" as const, externalId: "ig1", parentId: "page1", accessToken: "tok" };
  const dm = (text: string, replyId: string | null = null, platform: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") => ({ platform, accountExternalId: "ig1", kind: "DM" as const, direction: "IN" as const, externalId: `m-${Math.random()}`, threadKey: "cust1", parentExternalId: null, postExternalId: null, postCaption: null, authorId: "cust1", authorName: "sara_ig", text, createdAt: new Date(), replyId });

  it("keyword starts the flow with quick replies, a tap continues it, answers are saved", async () => {
    const store = new MemoryFlowStore();
    const sent: { kind: string; text: string; options?: { id: string; title: string }[] }[] = [];
    const recorded: string[] = [];
    const gateway = {
      replyToComment: async () => ({ id: "x" }),
      fetchRecent: async () => ({ events: [], warnings: [] }),
      sendDirectMessage: async (_a: unknown, _to: string, text: string) => (sent.push({ kind: "text", text }), { id: `out-${sent.length}` }),
      sendQuickReplies: async (_a: unknown, _to: string, text: string, options: { id: string; title: string }[]) => (sent.push({ kind: "quick", text, options }), { id: `out-${sent.length}` }),
    };
    const svc = new SocialFlowService(store, gateway, { record: async (_t, _a, ev) => (recorded.push(ev[0].text), 1) });

    expect(await svc.handle("t1", account, account, dm("hello"))).toBe(false);
    expect(await svc.handle("t1", account, account, dm("menu"))).toBe(true);
    expect(sent[0]).toMatchObject({ kind: "quick", text: "Hi sara_ig! Pick one" });
    expect(sent[0].options!.map((o) => o.title)).toEqual(["Prices", "Book"]);
    const bookId = sent[0].options![1].id;

    expect(await svc.handle("t1", account, account, dm("Book", bookId))).toBe(true);
    expect(sent[1]).toMatchObject({ kind: "text", text: "Your name?" });
    expect(await svc.handle("t1", account, account, dm("Sara Ali"))).toBe(true);
    expect(store.completed[0]).toMatchObject({ key: "ig:acc1:cust1", answers: { name: "Sara Ali" } });
    expect(recorded.length).toBe(2);

    // الفلو مش مفعّل على ماسنجر
    expect(await svc.handle("t1", { ...account, platform: "FACEBOOK" }, account, dm("menu", null, "FACEBOOK"))).toBe(false);
    // الموظف رد بنفسه قريب = السيناريو يسكت
    store.staff = true;
    expect(await svc.handle("t1", account, account, dm("menu"))).toBe(false);
  });

  it("webhook parser keeps the quick-reply payload", () => {
    const events = parseSocialWebhook({ object: "instagram", entry: [{ id: "ig1", messaging: [{ sender: { id: "cust1" }, recipient: { id: "ig1" }, timestamp: 1, message: { mid: "m1", text: "Book", quick_reply: { payload: "flow:s:1" } } }] }] });
    expect(events[0].replyId).toBe("flow:s:1");
  });
});
