import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { parseSocialWebhook } from "../modules/social/social-webhook.parser";
import { SocialInboxService } from "../modules/social/social-inbox.service";
import type { InboxAccountRow, InboxMessageView, InboxStore, ThreadView } from "../modules/social/social-inbox.repository";
import type { InboxAccount, InboxEvent, InboxKind, SocialInboxGateway } from "../modules/social/social-types";
import { SocialPlatformError } from "../modules/social/social-types";
import { encryptToken } from "../modules/social/token-crypto";
import type { CopyBrief, CopyGenerator } from "../modules/ai/copy-generator";

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

describe("parseSocialWebhook", () => {
  it("Facebook comment, reply and own comment", () => {
    const ev = parseSocialWebhook({
      object: "page",
      entry: [
        {
          id: "PAGE1",
          changes: [
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", post_id: "PAGE1_9", parent_id: "PAGE1_9", message: "كم السعر؟", from: { id: "u1", name: "Sara" }, created_time: 1793000000 } },
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "c2", post_id: "PAGE1_9", parent_id: "c1", message: "shukran", from: { id: "PAGE1", name: "Cafe" } } },
            { field: "feed", value: { item: "reaction", verb: "add" } },
            { field: "feed", value: { item: "comment", verb: "edited", comment_id: "c3", message: "x" } },
          ],
        },
      ],
    });
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ platform: "FACEBOOK", kind: "COMMENT", direction: "IN", threadKey: "c1", parentExternalId: null, authorName: "Sara", text: "كم السعر؟" });
    expect(ev[0].createdAt.getTime()).toBe(1793000000 * 1000);
    expect(ev[1]).toMatchObject({ direction: "OUT", threadKey: "c1", parentExternalId: "c1" });
  });

  it("Instagram comment + reply and DMs (incl. echo and attachment)", () => {
    const ev = parseSocialWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1793000000,
          changes: [
            { field: "comments", value: { id: "ic1", text: "😍", from: { id: "u9", username: "noor.qa" }, media: { id: "m1" } } },
            { field: "comments", value: { id: "ic2", text: "thanks", parent_id: "ic1", from: { id: "IG1", username: "cafe" }, media: { id: "m1" } } },
          ],
          messaging: [
            { sender: { id: "u9" }, recipient: { id: "IG1" }, timestamp: 1793000000123, message: { mid: "mid1", text: "مرحبا" } },
            { sender: { id: "IG1" }, recipient: { id: "u9" }, timestamp: 1793000001000, message: { mid: "mid2", text: "أهلين", is_echo: true } },
            { sender: { id: "u9" }, recipient: { id: "IG1" }, timestamp: 1793000002000, message: { mid: "mid3", attachments: [{ type: "image" }] } },
            { sender: { id: "u9" }, recipient: { id: "IG1" }, read: { mid: "mid2" } },
          ],
        },
      ],
    });
    expect(ev.map((e) => `${e.kind}:${e.direction}:${e.threadKey}:${e.text}`)).toEqual(["COMMENT:IN:ic1:😍", "COMMENT:OUT:ic1:thanks", "DM:IN:u9:مرحبا", "DM:OUT:u9:أهلين", "DM:IN:u9:[image]"]);
    expect(ev[0].authorName).toBe("noor.qa");
  });

  it("ignores other objects and junk", () => {
    expect(parseSocialWebhook({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(parseSocialWebhook(null)).toEqual([]);
    expect(parseSocialWebhook({ object: "page", entry: [{ changes: [{}] }] })).toEqual([]);
  });
});

type Row = InboxMessageView & { tenantId: string; accountId: string; threadKey: string; externalId: string; readAt: Date | null };

class MemoryInbox implements InboxStore {
  accounts = new Map<string, InboxAccountRow>();
  msgs: Row[] = [];
  addAccount(a: Partial<InboxAccountRow> & { id: string; platform: InboxAccountRow["platform"]; externalId: string }) {
    this.accounts.set(a.id, { tenantId: "t1", name: a.id, status: "ACTIVE", parentId: null, accessToken: encryptToken(`tok-${a.id}`), ...a });
  }
  async ownerOf(platform: string, externalId: string) {
    const a = [...this.accounts.values()].find((x) => x.platform === platform && x.externalId === externalId && x.status === "ACTIVE");
    return a ? { id: a.id, tenantId: a.tenantId } : null;
  }
  async account(tenantId: string, id: string) {
    const a = this.accounts.get(id);
    return a && a.tenantId === tenantId ? a : null;
  }
  async activeAccounts(tenantId: string) {
    return [...this.accounts.values()].filter((a) => a.tenantId === tenantId && a.status === "ACTIVE");
  }
  async record(tenantId: string, accountId: string, events: InboxEvent[]) {
    let n = 0;
    for (const e of events) {
      if (this.msgs.some((m) => m.accountId === accountId && m.externalId === e.externalId)) continue;
      this.msgs.push({ id: `m${this.msgs.length}`, tenantId, accountId, threadKey: e.threadKey, externalId: e.externalId, kind: e.kind, direction: e.direction, text: e.text, authorName: e.authorName, createdAt: e.createdAt, postCaption: e.postCaption, readAt: e.direction === "OUT" ? new Date() : null });
      n++;
    }
    return n;
  }
  async threads(tenantId: string): Promise<ThreadView[]> {
    const map = new Map<string, ThreadView>();
    for (const m of [...this.msgs].filter((x) => x.tenantId === tenantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
      const k = `${m.accountId}|${m.kind}|${m.threadKey}`;
      const a = this.accounts.get(m.accountId)!;
      if (!map.has(k)) map.set(k, { accountId: m.accountId, platform: a.platform, accountName: a.name, kind: m.kind as InboxKind, threadKey: m.threadKey, customerName: null, lastText: m.text, lastAt: m.createdAt, lastDirection: m.direction, lastInboundAt: null, unread: 0, postCaption: null });
      const t = map.get(k)!;
      if (m.direction === "IN") {
        t.customerName ??= m.authorName;
        t.lastInboundAt ??= m.createdAt;
        if (!m.readAt) t.unread++;
      }
    }
    return [...map.values()];
  }
  async messages(tenantId: string, accountId: string, kind: InboxKind, threadKey: string) {
    return this.msgs.filter((m) => m.tenantId === tenantId && m.accountId === accountId && m.kind === kind && m.threadKey === threadKey).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async markRead(tenantId: string, accountId: string, kind: InboxKind, threadKey: string) {
    for (const m of await this.messages(tenantId, accountId, kind, threadKey)) m.readAt ??= new Date();
  }
  async threadName(accountId: string, threadKey: string) {
    return this.msgs.find((m) => m.accountId === accountId && m.threadKey === threadKey && m.direction === "IN" && m.authorName)?.authorName ?? null;
  }
  async unreadCount(tenantId: string) {
    return this.msgs.filter((m) => m.tenantId === tenantId && m.direction === "IN" && !m.readAt).length;
  }
}

class FakeGateway implements SocialInboxGateway {
  calls: { op: string; account: InboxAccount; target: string; text: string }[] = [];
  recent: InboxEvent[] = [];
  fail: Error | null = null;
  async replyToComment(account: InboxAccount, commentId: string, text: string) {
    if (this.fail) throw this.fail;
    this.calls.push({ op: "comment", account, target: commentId, text });
    return { id: `r${this.calls.length}` };
  }
  async sendDirectMessage(account: InboxAccount, recipientId: string, text: string) {
    if (this.fail) throw this.fail;
    this.calls.push({ op: "dm", account, target: recipientId, text });
    return { id: `d${this.calls.length}` };
  }
  lookups = 0;
  async lookupName(_a: InboxAccount, userId: string) {
    this.lookups++;
    return userId === "u9" ? "noor.qa" : null;
  }
  async fetchRecent() {
    return { events: this.recent, warnings: [] };
  }
}

const NOW = new Date("2026-10-28T12:00:00Z");

function setup() {
  const store = new MemoryInbox();
  store.addAccount({ id: "fb", platform: "FACEBOOK", externalId: "PAGE1" });
  store.addAccount({ id: "ig", platform: "INSTAGRAM", externalId: "IG1", parentId: "PAGE1" });
  store.addAccount({ id: "x", platform: "FACEBOOK", externalId: "PAGE9", tenantId: "t2" });
  const gateway = new FakeGateway();
  const briefs: CopyBrief[] = [];
  const generator: CopyGenerator = {
    model: "fake",
    async generate(brief) {
      briefs.push(brief);
      return { variants: [1, 2, 3].map((i) => ({ text: `رد ${i}`, hashtags: [] })) };
    },
  };
  let balance = 5;
  const credits = {
    async chargeFor(req: { cost: number }, work: () => Promise<unknown>) {
      if (balance < req.cost) throw new Error("no credits");
      balance -= req.cost;
      try {
        return { result: await work(), balance };
      } catch (e) {
        balance += req.cost;
        throw e;
      }
    },
  };
  const generations = { create: vi.fn(async () => ({ id: "g" })) };
  const profiles = { business: async () => ({ name: "Karak Cafe", industry: "HOSPITALITY" }) };
  const service = new SocialInboxService(store, gateway, { generator, credits: credits as any, generations: generations as any, profiles: profiles as any }, () => NOW);
  return { store, gateway, service, briefs, generations, balance: () => balance };
}

const igDm = (mid: string, text: string, at: Date, echo = false) => ({
  object: "instagram",
  entry: [{ id: "IG1", messaging: [{ sender: { id: echo ? "IG1" : "u9" }, recipient: { id: echo ? "u9" : "IG1" }, timestamp: at.getTime(), message: { mid, text, ...(echo ? { is_echo: true } : {}) } }] }],
});

describe("SocialInboxService", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("webhook events land in the owning company once (duplicates ignored), unknown accounts skipped", async () => {
    const body = igDm("mid1", "عندكم توصيل؟", new Date(NOW.getTime() - 60_000));
    expect(await s.service.handleWebhook(body)).toEqual({ received: 1, saved: 1 });
    expect(await s.service.handleWebhook(body)).toEqual({ received: 1, saved: 0 });
    expect(await s.service.handleWebhook({ object: "page", entry: [{ id: "UNKNOWN", messaging: [{ sender: { id: "a" }, recipient: { id: "UNKNOWN" }, message: { mid: "z", text: "hi" } }] }] })).toEqual({ received: 1, saved: 0 });
    const threads = await s.service.threads("t1", {});
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ kind: "DM", threadKey: "u9", unread: 1, canReply: true, customerName: "noor.qa" });
    // الاسم بيتجاب مرة واحدة بس لكل محادثة
    await s.service.handleWebhook(igDm("mid2", "?", NOW));
    expect(s.gateway.lookups).toBe(1);
    expect(await s.service.threads("t2", {})).toHaveLength(0);
  });

  it("opening a thread marks it read; replying to a DM goes through the linked page", async () => {
    await s.service.handleWebhook(igDm("mid1", "عندكم توصيل؟", new Date(NOW.getTime() - 60_000)));
    const ref = { accountId: "ig", kind: "DM" as const, threadKey: "u9" };
    const t = await s.service.thread("t1", ref);
    expect(t.canReply).toBe(true);
    expect(await s.service.unreadCount("t1")).toBe(0);
    const after = await s.service.reply("t1", "u1", ref, "  نعم، التوصيل متاح ✅ ");
    expect(s.gateway.calls[0]).toMatchObject({ op: "dm", target: "u9", text: "نعم، التوصيل متاح ✅" });
    expect(s.gateway.calls[0].account).toMatchObject({ platform: "INSTAGRAM", parentId: "PAGE1", accessToken: "tok-ig" });
    expect(after.messages.map((m) => m.direction)).toEqual(["IN", "OUT"]);
    // نفس الرد لما يرجع كـ echo من Meta مابيتكررش
    await s.service.handleWebhook(igDm("d1", "نعم، التوصيل متاح ✅", NOW, true));
    expect((await s.service.thread("t1", ref)).messages).toHaveLength(2);
  });

  it("DM older than 24h can't be answered (Meta rule); comments always can", async () => {
    await s.service.handleWebhook(igDm("old", "hello?", new Date(NOW.getTime() - 25 * 3600_000)));
    const ref = { accountId: "ig", kind: "DM" as const, threadKey: "u9" };
    expect((await s.service.threads("t1", {}))[0].canReply).toBe(false);
    await expect(s.service.reply("t1", null, ref, "late")).rejects.toMatchObject({ status: 422, code: "WINDOW_CLOSED" });
    expect(s.gateway.calls).toHaveLength(0);

    await s.service.handleWebhook({ object: "page", entry: [{ id: "PAGE1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", post_id: "P_1", parent_id: "P_1", message: "nice", from: { id: "u1", name: "Ali" }, created_time: Math.floor((NOW.getTime() - 40 * 86400_000) / 1000) } }] }] });
    await s.service.reply("t1", null, { accountId: "fb", kind: "COMMENT", threadKey: "c1" }, "Thank you Ali!");
    expect(s.gateway.calls[0]).toMatchObject({ op: "comment", target: "c1" });
  });

  it("other company can't read or reply to the thread; Meta errors are passed on clearly", async () => {
    await s.service.handleWebhook(igDm("mid1", "hi", NOW));
    const ref = { accountId: "ig", kind: "DM" as const, threadKey: "u9" };
    await expect(s.service.thread("t2", ref)).rejects.toMatchObject({ status: 404 });
    await expect(s.service.reply("t2", null, ref, "x")).rejects.toMatchObject({ status: 404 });
    s.gateway.fail = new SocialPlatformError("(#10) This message is sent outside of allowed window");
    await expect(s.service.reply("t1", null, ref, "x")).rejects.toThrow(/Meta: \(#10\)/);
  });

  it("AI suggestion: 3 replies, 1 credit, uses the post + conversation, nothing charged on failure", async () => {
    await s.service.handleWebhook({ object: "page", entry: [{ id: "PAGE1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", post_id: "P_1", parent_id: "P_1", message: "بكم الكرك؟", from: { id: "u1", name: "Ali" }, post: { message: "كرك جديد بالزعفران" } } }] }] });
    const ref = { accountId: "fb", kind: "COMMENT" as const, threadKey: "c1" };
    const r = await s.service.suggest("t1", "u1", ref);
    expect(r.suggestions).toEqual(["رد 1", "رد 2", "رد 3"]);
    expect(r.balance).toBe(4);
    expect(s.briefs[0]).toMatchObject({ kind: "reply", topic: "بكم الكرك؟", platform: "facebook", dialect: "qatari" });
    expect(s.briefs[0].details).toMatch(/كرك جديد بالزعفران/);
    expect(s.briefs[0].details).toMatch(/public comment/);
    expect(s.generations.create).toHaveBeenCalledWith(expect.objectContaining({ tool: "reply" }));
  });

  it("suggestion needs a customer message", async () => {
    await s.service.handleWebhook(igDm("e1", "our message", NOW, true));
    await expect(s.service.suggest("t1", null, { accountId: "ig", kind: "DM", threadKey: "u9" })).rejects.toThrow(/no customer message/);
  });

  it("sync pulls recent items per account and reports per-account errors", async () => {
    s.gateway.recent = parseSocialWebhook(igDm("s1", "from sync", NOW));
    const r = await s.service.sync("t1");
    expect(r).toMatchObject({ accounts: 2, errors: [] });
    expect(r.added).toBe(2); // نفس الحدث اتسجل للحسابين في الاختبار ده
    s.gateway.fetchRecent = async () => {
      throw new SocialPlatformError("(#200) Requires pages_read_engagement");
    };
    const r2 = await s.service.sync("t1");
    expect(r2.errors[0]).toMatch(/pages_read_engagement/);
  });
});
