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
  add(c: Partial<CampaignForSend> & { id: string }) {
    this.campaigns.set(c.id, { tenantId: "t1", kind: "TEXT", status: "DRAFT", audioBase64: null, recipients: [], template: null, sentCount: 0, failedCount: 0, ...c });
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
    if (!c || c.tenantId !== tenantId || !["DRAFT", "READY", "FAILED"].includes(c.status)) return false;
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
  async finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number) {
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
    expect(out).toEqual({ ok: true, status: "SENDING", total: 23 });
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
});
