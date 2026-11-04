import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { CommentAutomationService, fillName, ruleMatches } from "../modules/social/comment-automation.service";
import type { CommentRule, CommentRuleInput, CommentRuleStore } from "../modules/social/comment-rules.repository";
import type { InboxAccount, InboxEvent, SocialInboxGateway } from "../modules/social/social-types";

class MemoryRules implements CommentRuleStore {
  rules: (CommentRule & { tenantId: string })[] = [];
  hits = new Map<string, { ok: boolean; error: string | null }>();
  authors = new Set<string>();
  accounts = new Set(["acc-1"]);
  private n = 0;
  async list(t: string) {
    return this.rules.filter((r) => r.tenantId === t);
  }
  async active(t: string, accountId: string) {
    return this.rules.filter((r) => r.tenantId === t && r.enabled && (r.accountId === null || r.accountId === accountId));
  }
  async create(t: string, input: CommentRuleInput) {
    const r = { ...input, id: `r${++this.n}`, tenantId: t, sentCount: 0, createdAt: new Date() };
    this.rules.push(r);
    return r;
  }
  async update(t: string, id: string, input: Partial<CommentRuleInput>) {
    const r = this.rules.find((x) => x.id === id && x.tenantId === t);
    if (!r) return null;
    Object.assign(r, input);
    return r;
  }
  async delete(t: string, id: string) {
    const before = this.rules.length;
    this.rules = this.rules.filter((x) => !(x.id === id && x.tenantId === t));
    return this.rules.length < before;
  }
  async accountBelongs(_t: string, id: string) {
    return this.accounts.has(id);
  }
  async claimHit(ruleId: string, commentId: string, authorId: string) {
    const a = `${ruleId}:${authorId}`;
    const c = `${ruleId}:${commentId}`;
    if (this.authors.has(a) || this.hits.has(c)) return false;
    this.authors.add(a);
    this.hits.set(c, { ok: true, error: null });
    return true;
  }
  async finishHit(ruleId: string, commentId: string, ok: boolean, error: string | null) {
    this.hits.set(`${ruleId}:${commentId}`, { ok, error });
    if (ok) this.rules.find((r) => r.id === ruleId)!.sentCount++;
  }
}

class FakeGateway implements Partial<SocialInboxGateway> {
  dms: { comment: string; text: string }[] = [];
  publicReplies: { comment: string; text: string }[] = [];
  failDm = false;
  async privateReply(_a: InboxAccount, commentId: string, text: string) {
    if (this.failDm) throw new Error("(#10) outside the allowed window");
    this.dms.push({ comment: commentId, text });
    return { id: `m-${commentId}` };
  }
  async replyToComment(_a: InboxAccount, commentId: string, text: string) {
    this.publicReplies.push({ comment: commentId, text });
    return { id: `c-${commentId}` };
  }
}

const account: InboxAccount = { platform: "INSTAGRAM", externalId: "IG1", parentId: "PAGE1", accessToken: "tok" };
const comment = (id: string, text: string, author = "u1", name: string | null = "Sara", over: Partial<InboxEvent> = {}): InboxEvent => ({
  platform: "INSTAGRAM",
  accountExternalId: "IG1",
  kind: "COMMENT",
  direction: "IN",
  externalId: id,
  threadKey: id,
  parentExternalId: null,
  postExternalId: "media1",
  postCaption: null,
  authorId: author,
  authorName: name,
  text,
  createdAt: new Date(),
  ...over,
});

function setup() {
  const store = new MemoryRules();
  const gateway = new FakeGateway();
  return { store, gateway, service: new CommentAutomationService(store, gateway as unknown as SocialInboxGateway) };
}

const base: CommentRuleInput = { accountId: null, name: "Price", keywords: ["price", "سعر"], dmText: "Hi {name}! Prices: https://x.test/menu", publicReply: "Sent you a DM 📩", enabled: true };

describe("comment → DM automation", () => {
  it("matching comment → one private reply (+ public reply), once per person per rule", async () => {
    const { service, gateway, store } = setup();
    await service.create("t1", base);
    const r = await service.run("t1", "acc-1", account, [comment("c1", "what's the price?"), comment("c2", "nice pic"), comment("c3", "PRICE please"), comment("c4", "السعر كام؟ سعر", "u2", null)]);
    expect(r.sent).toBe(2);
    expect(gateway.dms).toEqual([
      { comment: "c1", text: "Hi Sara! Prices: https://x.test/menu" },
      { comment: "c4", text: "Hi! Prices: https://x.test/menu" },
    ]);
    expect(gateway.publicReplies.map((p) => p.comment)).toEqual(["c1", "c4"]);
    expect(store.rules[0].sentCount).toBe(2);
    // نفس الحدث جه تاني من Meta ← مافيش رسالة تانية
    expect((await service.run("t1", "acc-1", account, [comment("c1", "price")])).sent).toBe(0);
  });

  it("ignores the page's own comments, outgoing events and DMs; respects account + enabled", async () => {
    const { service, gateway } = setup();
    await service.create("t1", { ...base, accountId: "acc-1" });
    await service.create("t1", { ...base, name: "Off", keywords: ["menu"], enabled: false });
    await service.run("t1", "acc-1", account, [comment("c1", "price", "IG1"), comment("c2", "price", "u5", "x", { direction: "OUT" }), comment("c3", "price", "u6", "x", { kind: "DM" }), comment("c4", "menu", "u7")]);
    expect(gateway.dms).toHaveLength(0);
    expect((await service.run("t1", "acc-other", account, [comment("c5", "price", "u8")])).sent).toBe(0);
    expect((await service.run("t2", "acc-1", account, [comment("c6", "price", "u9")])).sent).toBe(0);
  });

  it("a rule without keywords answers any comment; a failed DM is recorded and not counted", async () => {
    const { service, gateway, store } = setup();
    await service.create("t1", { ...base, keywords: [], publicReply: null });
    gateway.failDm = true;
    expect((await service.run("t1", "acc-1", account, [comment("c1", "wow")])).sent).toBe(0);
    expect(store.hits.get("r1:c1")).toEqual({ ok: false, error: "(#10) outside the allowed window" });
    expect(store.rules[0].sentCount).toBe(0);
  });

  it("validation: name + DM required, account must belong to the company, limits", async () => {
    const { service } = setup();
    await expect(service.create("t1", { ...base, name: " " })).rejects.toMatchObject({ status: 400 });
    await expect(service.create("t1", { ...base, dmText: "" })).rejects.toMatchObject({ status: 400 });
    await expect(service.create("t1", { ...base, accountId: "someone-else" })).rejects.toMatchObject({ status: 400 });
    const r = await service.create("t1", { ...base, keywords: [" price ", "price", ""] });
    expect(r.keywords).toEqual(["price"]);
    await expect(service.update("t2", r.id, { name: "hack" })).rejects.toMatchObject({ status: 404 });
    await expect(service.remove("t2", r.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.update("t1", r.id, { enabled: false })).enabled).toBe(false);
  });

  it("helpers", () => {
    expect(ruleMatches({ keywords: ["link"] }, "send me the LINK!")).toBe(true);
    expect(ruleMatches({ keywords: ["link"] }, "linked")).toBe(false);
    expect(ruleMatches({ keywords: [] }, "  ")).toBe(false);
    expect(fillName("Hi {name}, welcome", null)).toBe("Hi, welcome");
    expect(fillName("Hi {name}!", "Sara")).toBe("Hi Sara!");
  });
});
