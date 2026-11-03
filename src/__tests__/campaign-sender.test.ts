import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { CampaignSender, runPool } from "../modules/whatsapp/campaign-sender.service";
import type { CampaignForSend, CampaignStore, CampaignTemplate, MetaConnection, OutgoingMessage } from "../modules/whatsapp/campaign.repository";
import type { CampaignGateway, GatewayTemplate, SendResult } from "../modules/whatsapp/campaign-gateway";

const tick = () => new Promise((r) => setImmediate(r));

// تخزين في الذاكرة بنفس عقد Prisma
class MemoryCampaigns implements CampaignStore {
  campaigns = new Map<string, CampaignForSend & { sentCount: number; failedCount: number }>();
  inbox: OutgoingMessage[] = [];
  progressWrites: [number, number][] = [];
  connected = true;
  book: { phone: string; name: string; tags: string[]; optedOut: boolean }[] = [];
  scheduledAt = new Map<string, Date>();
  failures = new Map<string, string>();
  skippedWrites = new Map<string, number>();
  add(c: Partial<CampaignForSend> & { id: string }) {
    this.campaigns.set(c.id, { tenantId: "t1", kind: "TEXT", status: "DRAFT", audioBase64: null, recipients: [], audienceTags: [], audienceMatch: "any", template: null, sentCount: 0, failedCount: 0, ...c });
  }
  async audience(_t: string, tags: string[], match: "any" | "all") {
    return this.book.filter((b) => !b.optedOut && (match === "all" ? tags.every((t) => b.tags.includes(t)) : tags.some((t) => b.tags.includes(t)))).map((b) => ({ phone: b.phone, name: b.name }));
  }
  async optedOutAmong(_t: string, phones: string[]) {
    return new Set(this.book.filter((b) => b.optedOut && phones.includes(b.phone)).map((b) => b.phone));
  }
  async schedule(tenantId: string, id: string, at: Date) {
    const c = this.campaigns.get(id);
    if (!c || c.tenantId !== tenantId || !["DRAFT", "READY", "FAILED", "SCHEDULED"].includes(c.status)) return false;
    c.status = "SCHEDULED";
    this.scheduledAt.set(id, at);
    return true;
  }
  async unschedule(tenantId: string, id: string) {
    const c = this.campaigns.get(id);
    if (!c || c.tenantId !== tenantId || c.status !== "SCHEDULED") return false;
    c.status = "DRAFT";
    return true;
  }
  async dueScheduled(now: Date) {
    return [...this.campaigns.values()].filter((c) => c.status === "SCHEDULED" && (this.scheduledAt.get(c.id)?.getTime() ?? 0) <= now.getTime()).map((c) => ({ id: c.id, tenantId: c.tenantId }));
  }
  async markFailed(id: string, error: string) {
    this.campaigns.get(id)!.status = "FAILED";
    this.failures.set(id, error);
  }
  async connection(): Promise<MetaConnection | null> {
    return this.connected ? { token: "tok", phoneNumberId: "pn" } : null;
  }
  async findForSend(tenantId: string, id: string) {
    const c = this.campaigns.get(id);
    return c && c.tenantId === tenantId ? structuredClone(c) : null;
  }
  async setTemplateStatus(_templateId: string, status: string): Promise<CampaignTemplate> {
    for (const c of this.campaigns.values()) if (c.template) c.template.status = status;
    return { ...[...this.campaigns.values()].find((c) => c.template)!.template! };
  }
  async claim(tenantId: string, id: string) {
    await tick();
    const c = this.campaigns.get(id);
    if (!c || c.tenantId !== tenantId || !["DRAFT", "READY", "SCHEDULED", "FAILED"].includes(c.status)) return false;
    c.status = "SENDING";
    return true;
  }
  async release(id: string, status: string) {
    this.campaigns.get(id)!.status = status;
  }
  async progress(id: string, sent: number, failed: number) {
    this.progressWrites.push([sent, failed]);
    Object.assign(this.campaigns.get(id)!, { sentCount: sent, failedCount: failed });
  }
  async finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number, skipped = 0) {
    this.skippedWrites.set(id, skipped);
    Object.assign(this.campaigns.get(id)!, { status, sentCount: sent, failedCount: failed });
  }
  async expireStale() {
    return 0;
  }
  async recordOutgoing(m: OutgoingMessage) {
    this.inbox.push(m);
  }
}

// واتساب وهمي: بنعدّ النداءات وبنقيس أقصى عدد شغال في نفس الوقت
class FakeGateway implements CampaignGateway {
  sends: { to: string; name?: string; components?: Record<string, unknown>[] }[] = [];
  uploads = 0;
  inFlight = 0;
  maxInFlight = 0;
  failFor = new Set<string>();
  templateStatusAnswer: string | null = null;
  async templateStatus() {
    return this.templateStatusAnswer ? { ok: true, status: this.templateStatusAnswer } : { ok: false };
  }
  async uploadTemplateImages(_c: MetaConnection, tpl: GatewayTemplate) {
    this.uploads++;
    return { ok: true, mediaIds: tpl.headerImageDataUrl ? ["media-1"] : [] };
  }
  async uploadAudio() {
    this.uploads++;
    return { ok: true, mediaId: "audio-1" };
  }
  private async send(to: string, extra: { name?: string; components?: Record<string, unknown>[] } = {}): Promise<SendResult> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 2));
    this.inFlight--;
    this.sends.push({ to, ...extra });
    return this.failFor.has(to) ? { ok: false, error: "Meta said no" } : { ok: true, messageId: `wamid.${to}` };
  }
  sendTemplate(_c: MetaConnection, to: string, name: string, _l: string, components: Record<string, unknown>[]) {
    return this.send(to, { name, components });
  }
  sendHelloWorld(_c: MetaConnection, to: string) {
    return this.send(to, { name: "hello_world" });
  }
  sendAudio(_c: MetaConnection, to: string) {
    return this.send(to, { name: "audio" });
  }
}

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ phone: `9745500${String(i).padStart(4, "0")}`, name: `Customer ${i}` }));
const tpl = (over: Partial<CampaignTemplate> = {}): CampaignTemplate => ({
  id: "tpl1",
  name: "weekend_offer",
  language: "ar",
  status: "APPROVED",
  metaTemplateId: "m1",
  bodyText: "Hi {{1}}, weekend offer!",
  format: "STANDARD",
  headerImageDataUrl: "data:image/jpeg;base64,AAAA",
  cards: null,
  ...over,
});

function setup() {
  const store = new MemoryCampaigns();
  const gateway = new FakeGateway();
  const sender = new CampaignSender(store, gateway, { concurrency: 5, progressEvery: 10, staleAfterMs: 60_000 });
  return { store, gateway, sender };
}

describe("CampaignSender", () => {
  it("answers at once (SENDING), sends in the background max 5 at a time, counts sent/failed", async () => {
    const { store, gateway, sender } = setup();
    const recipients = people(23);
    store.add({ id: "c1", recipients, template: tpl() });
    gateway.failFor = new Set([recipients[3].phone, recipients[7].phone]);
    const out = await sender.start("t1", "c1");
    expect(out).toEqual({ ok: true, status: "SENDING", total: 23, skipped: 0 });
    expect(store.campaigns.get("c1")!.status).toBe("SENDING");
    await sender.whenIdle();
    const c = store.campaigns.get("c1")!;
    expect(c).toMatchObject({ status: "SENT", sentCount: 21, failedCount: 2 });
    expect(gateway.maxInFlight).toBeLessThanOrEqual(5);
    expect(gateway.maxInFlight).toBeGreaterThan(1);
    expect(gateway.uploads).toBe(1); // الصورة اترفعت مرة واحدة للحملة كلها
    expect(store.progressWrites.length).toBeGreaterThanOrEqual(2); // العدّاد اتحدث وهي شغالة
    expect(store.inbox).toHaveLength(23);
    expect(store.inbox[0].body).toMatch(/^🖼️ Hi Customer/);
    // {{1}} = اسم العميل + صورة الرأس بالـ media id
    const first = gateway.sends.find((s) => s.to === recipients[0].phone)!;
    expect(JSON.stringify(first.components)).toContain("media-1");
    expect(JSON.stringify(first.components)).toContain("Customer 0");
  });
  it("a second send while it's running (or after it was sent) → 409, nothing sent twice", async () => {
    const { store, gateway, sender } = setup();
    store.add({ id: "c1", recipients: people(8) });
    const results = await Promise.allSettled([sender.start("t1", "c1"), sender.start("t1", "c1")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: "CAMPAIGN_BUSY" });
    await sender.whenIdle();
    expect(gateway.sends).toHaveLength(8);
    expect(gateway.sends.every((s) => s.name === "hello_world")).toBe(true);
    await expect(sender.start("t1", "c1")).rejects.toMatchObject({ status: 409 });
  });
  it("everyone failed → FAILED (and it can be sent again)", async () => {
    const { store, gateway, sender } = setup();
    const recipients = people(3);
    store.add({ id: "c1", recipients });
    gateway.failFor = new Set(recipients.map((r) => r.phone));
    await sender.start("t1", "c1");
    await sender.whenIdle();
    expect(store.campaigns.get("c1")).toMatchObject({ status: "FAILED", sentCount: 0, failedCount: 3 });
    gateway.failFor.clear();
    await sender.start("t1", "c1");
    await sender.whenIdle();
    expect(store.campaigns.get("c1")).toMatchObject({ status: "SENT", sentCount: 3 });
  });
  it("checks happen BEFORE the claim: >1 blank, not approved, no list, not connected, other company", async () => {
    const { store, gateway, sender } = setup();
    store.add({ id: "two", recipients: people(2), template: tpl({ bodyText: "Hi {{1}} {{2}}" }) });
    await expect(sender.start("t1", "two")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/2 blanks/) });
    expect(store.campaigns.get("two")!.status).toBe("DRAFT");
    store.add({ id: "pending", recipients: people(2), template: tpl({ status: "PENDING" }) });
    await expect(sender.start("t1", "pending")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/isn't approved/) });
    store.add({ id: "empty" });
    await expect(sender.start("t1", "empty")).rejects.toMatchObject({ status: 400 });
    await expect(sender.start("other-company", "two")).rejects.toMatchObject({ status: 404 });
    store.connected = false;
    await expect(sender.start("t1", "two")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Connect/) });
    expect(gateway.sends).toHaveLength(0);
  });
  it("a PENDING template is re-checked with Meta first and sent once approved", async () => {
    const { store, gateway, sender } = setup();
    store.add({ id: "c1", recipients: people(2), template: tpl({ status: "PENDING", headerImageDataUrl: null, bodyText: "Hello" }) });
    gateway.templateStatusAnswer = "APPROVED";
    await sender.start("t1", "c1");
    await sender.whenIdle();
    expect(gateway.sends.map((s) => s.name)).toEqual(["weekend_offer", "weekend_offer"]);
  });
  it("voice campaign: audio uploaded once, sent to everyone", async () => {
    const { store, gateway, sender } = setup();
    store.add({ id: "v1", kind: "VOICE", audioBase64: "AAAA", recipients: people(4) });
    await sender.start("t1", "v1");
    await sender.whenIdle();
    expect(gateway.uploads).toBe(1);
    expect(gateway.sends.filter((s) => s.name === "audio")).toHaveLength(4);
    expect(store.campaigns.get("v1")).toMatchObject({ status: "SENT", sentCount: 4 });
  });
  it("runPool never runs more than the limit", async () => {
    let now = 0;
    let max = 0;
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      max = Math.max(max, ++now);
      await tick();
      now--;
    });
    expect(max).toBe(3);
  });

  it('skips people who unsubscribed and dedupes the list', async () => {
    const { store, gateway, sender } = setup();
    const list = people(4);
    store.book = [{ phone: list[1].phone, name: 'x', tags: [], optedOut: true }];
    store.add({ id: 'c1', recipients: [...list, list[0]] });
    const out = await sender.start('t1', 'c1');
    expect(out).toMatchObject({ total: 3, skipped: 2 });
    await sender.whenIdle();
    expect(gateway.sends.map((x) => x.to).sort()).toEqual([list[0].phone, list[2].phone, list[3].phone].sort());
    expect(store.skippedWrites.get('c1')).toBe(2);
    expect(store.inbox.every((m) => m.campaignId === 'c1')).toBe(true);
  });
  it('audience from contact tags (any / all), subscribed only', async () => {
    const { store, gateway, sender } = setup();
    store.book = [
      { phone: '97450000001', name: 'A', tags: ['vip', 'doha'], optedOut: false },
      { phone: '97450000002', name: 'B', tags: ['vip'], optedOut: false },
      { phone: '97450000003', name: 'C', tags: ['vip', 'doha'], optedOut: true },
    ];
    store.add({ id: 'any', audienceTags: ['doha', 'vip'], audienceMatch: 'any' });
    expect(await sender.start('t1', 'any')).toMatchObject({ total: 2 });
    await sender.whenIdle();
    store.add({ id: 'all', audienceTags: ['doha', 'vip'], audienceMatch: 'all' });
    expect(await sender.start('t1', 'all')).toMatchObject({ total: 1 });
    await sender.whenIdle();
    store.add({ id: 'none', audienceTags: ['nobody'] });
    await expect(sender.start('t1', 'none')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/No subscribed contacts/) });
    expect(gateway.sends).toHaveLength(3);
  });
  it('schedule: validated up front, sent by runDue when due, cancel works, failures recorded', async () => {
    const { store, gateway, sender } = setup();
    const now = new Date('2026-11-03T10:00:00Z');
    store.add({ id: 'c1', recipients: people(3) });
    await expect(sender.schedule('t1', 'c1', new Date(now.getTime() + 10_000), now)).rejects.toMatchObject({ status: 400 });
    await expect(sender.schedule('t1', 'c1', new Date(now.getTime() + 100 * 86400_000), now)).rejects.toMatchObject({ status: 400 });
    store.add({ id: 'pending', recipients: people(2), template: tpl({ status: 'PENDING' }) });
    await expect(sender.schedule('t1', 'pending', new Date(now.getTime() + 3600_000), now)).rejects.toMatchObject({ message: expect.stringMatching(/isn't approved/) });
    const at = new Date(now.getTime() + 3600_000);
    expect(await sender.schedule('t1', 'c1', at, now)).toMatchObject({ status: 'SCHEDULED', total: 3 });
    expect(await sender.runDue(now)).toEqual({ started: 0, failed: 0 });
    expect(await sender.runDue(new Date(at.getTime() + 1000))).toEqual({ started: 1, failed: 0 });
    await sender.whenIdle();
    expect(store.campaigns.get('c1')).toMatchObject({ status: 'SENT', sentCount: 3 });
    await expect(sender.schedule('t1', 'c1', at, now)).rejects.toMatchObject({ status: 409 });
    store.add({ id: 'c2', recipients: people(1) });
    await sender.schedule('t1', 'c2', at, now);
    await sender.unschedule('t1', 'c2');
    expect(store.campaigns.get('c2')!.status).toBe('DRAFT');
    await expect(sender.unschedule('t1', 'c2')).rejects.toMatchObject({ status: 409 });
    store.add({ id: 'c3', recipients: people(1) });
    await sender.schedule('t1', 'c3', at, now);
    store.connected = false;
    expect(await sender.runDue(new Date(at.getTime() + 1000))).toEqual({ started: 0, failed: 1 });
    expect(store.campaigns.get('c3')!.status).toBe('FAILED');
    expect(store.failures.get('c3')).toMatch(/Connect/);
    expect(gateway.sends).toHaveLength(3);
  });
});
