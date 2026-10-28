import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { SocialPostService } from "../modules/social/social-post.service";
import { SocialAccountService } from "../modules/social/social-account.service";
import { MetaSocialGateway } from "../modules/social/meta-social.gateway";
import { decryptToken, encryptToken } from "../modules/social/token-crypto";
import { EDITABLE_STATUSES, type AccountForPublish, type NewPost, type PostPatch, type PostView, type SocialStore } from "../modules/social/social.repository";
import { SocialPlatformError, type DiscoveredAccount, type MetaAccountConnector, type PostOptions, type PublishAccount, type PublishContent, type SocialPublisher } from "../modules/social/social-types";
import type { StoredTokens } from "../modules/social/social.repository";

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

type Acc = AccountForPublish & { name: string; username: string | null; lastError: string | null };
type Target = { id: string; accountId: string; status: string; permalink: string | null; error: string | null; externalPostId?: string; publishedAt: Date | null };
type Post = { id: string; tenantId: string; caption: string; mediaId: string | null; options: PostOptions | null; status: string; scheduledAt: Date | null; publishingAt: Date | null; publishedAt: Date | null; createdAt: Date; targets: Target[] };

// تخزين في الذاكرة بنفس عقد Prisma
class MemoryStore implements SocialStore {
  accounts = new Map<string, Acc>();
  media = new Map<string, { id: string; tenantId: string; kind: "image" | "video"; mimeType: string; data: Buffer; publicKey: string }>();
  posts = new Map<string, Post>();
  seq = 0;
  id(p: string) {
    return `${p}-${++this.seq}`.padEnd(8, "0");
  }
  addAccount(a: Partial<Acc> & { id: string; platform: Acc["platform"] }) {
    this.accounts.set(a.id, { tenantId: "t1", externalId: `ext-${a.id}`, accessToken: encryptToken(`token-${a.id}`), tokenExpiresAt: null, refreshToken: null, status: "ACTIVE", name: a.id, username: null, lastError: null, ...a });
  }
  async upsertAccounts(tenantId: string, _u: string | null, list: DiscoveredAccount[]) {
    for (const a of list) {
      const existing = [...this.accounts.values()].find((x) => x.tenantId === tenantId && x.platform === a.platform && x.externalId === a.externalId);
      const id = existing?.id ?? this.id("acc");
      this.accounts.set(id, { id, tenantId, platform: a.platform, externalId: a.externalId, accessToken: a.accessToken, tokenExpiresAt: a.tokenExpiresAt, refreshToken: a.refreshToken ?? null, status: "ACTIVE", name: a.name, username: a.username, lastError: null });
    }
  }
  async listAccounts(tenantId: string) {
    return [...this.accounts.values()]
      .filter((a) => a.tenantId === tenantId && a.status !== "DISCONNECTED")
      .map((a) => ({ id: a.id, platform: a.platform, externalId: a.externalId, name: a.name, username: a.username, pictureUrl: null, status: a.status, lastError: a.lastError, createdAt: new Date() }));
  }
  async accountsByIds(tenantId: string, ids: string[]) {
    return ids.map((id) => this.accounts.get(id)).filter((a): a is Acc => Boolean(a && a.tenantId === tenantId)).map((a) => ({ id: a.id, platform: a.platform, status: a.status }));
  }
  async accountForPublish(id: string) {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }
  async markAccount(id: string, status: string, lastError: string | null) {
    Object.assign(this.accounts.get(id)!, { status, lastError });
  }
  tokenWrites: StoredTokens[] = [];
  async updateTokens(id: string, t: StoredTokens) {
    this.tokenWrites.push(t);
    Object.assign(this.accounts.get(id)!, { accessToken: t.accessToken, tokenExpiresAt: t.tokenExpiresAt, refreshToken: t.refreshToken });
  }
  async mediaData(id: string) {
    return this.media.get(id)?.data ?? null;
  }
  async disconnectAccount(tenantId: string, id: string) {
    const a = this.accounts.get(id);
    if (!a || a.tenantId !== tenantId) return false;
    Object.assign(a, { status: "DISCONNECTED", accessToken: "" });
    return true;
  }
  async saveMedia(m: { tenantId: string; kind: "image" | "video"; mimeType: string; data: Buffer; publicKey: string }) {
    const id = crypto.randomUUID();
    this.media.set(id, { id, ...m });
    return { id, kind: m.kind, size: m.data.length };
  }
  async mediaRef(tenantId: string, id: string) {
    const m = this.media.get(id);
    return m && m.tenantId === tenantId ? { id, kind: m.kind, mimeType: m.mimeType, publicKey: m.publicKey } : null;
  }
  async mediaByKey(key: string) {
    const m = [...this.media.values()].find((x) => x.publicKey === key);
    return m ? { id: m.id, mimeType: m.mimeType, size: m.data.length, data: m.data } : null;
  }
  async createPost(p: NewPost) {
    const id = this.id("post");
    this.posts.set(id, {
      id,
      tenantId: p.tenantId,
      caption: p.caption,
      mediaId: p.mediaId,
      status: p.status,
      scheduledAt: p.scheduledAt,
      options: p.options,
      publishingAt: null,
      publishedAt: null,
      createdAt: new Date(),
      targets: p.accountIds.map((accountId) => ({ id: this.id("tg"), accountId, status: "PENDING", permalink: null, error: null, publishedAt: null })),
    });
    return id;
  }
  async updatePost(tenantId: string, id: string, patch: PostPatch) {
    const p = this.posts.get(id);
    if (!p || p.tenantId !== tenantId || !EDITABLE_STATUSES.includes(p.status)) return false;
    const { accountIds, ...fields } = patch;
    Object.assign(p, fields);
    if (accountIds) p.targets = accountIds.map((accountId) => ({ id: this.id("tg"), accountId, status: "PENDING", permalink: null, error: null, publishedAt: null }));
    return true;
  }
  view(p: Post): PostView {
    return {
      id: p.id,
      caption: p.caption,
      status: p.status,
      scheduledAt: p.scheduledAt,
      publishedAt: p.publishedAt,
      createdAt: p.createdAt,
      options: p.options,
      media: p.mediaId ? { id: p.mediaId, kind: this.media.get(p.mediaId)!.kind } : null,
      targets: p.targets.map((t) => ({ ...t, platform: this.accounts.get(t.accountId)!.platform, accountName: this.accounts.get(t.accountId)!.name })),
    };
  }
  async getPost(tenantId: string, id: string) {
    const p = this.posts.get(id);
    return p && p.tenantId === tenantId ? this.view(p) : null;
  }
  async listPosts(tenantId: string) {
    return [...this.posts.values()].filter((p) => p.tenantId === tenantId).map((p) => this.view(p));
  }
  async deletePost(tenantId: string, id: string) {
    const p = this.posts.get(id);
    if (!p || p.tenantId !== tenantId || p.status === "PUBLISHING") return false;
    return this.posts.delete(id);
  }
  async claim(id: string, now: Date) {
    await new Promise((r) => setImmediate(r));
    const p = this.posts.get(id);
    if (!p || p.status !== "SCHEDULED") return false;
    Object.assign(p, { status: "PUBLISHING", publishingAt: now });
    return true;
  }
  async postForPublish(id: string) {
    const p = this.posts.get(id);
    if (!p) return null;
    const m = p.mediaId ? this.media.get(p.mediaId)! : null;
    return { id, tenantId: p.tenantId, caption: p.caption, options: p.options, media: m ? { id: m.id, kind: m.kind, mimeType: m.mimeType, publicKey: m.publicKey } : null, targets: p.targets.map((t) => ({ id: t.id, accountId: t.accountId, status: t.status })) };
  }
  async finishTarget(targetId: string, r: Partial<Target>) {
    for (const p of this.posts.values()) for (const t of p.targets) if (t.id === targetId) Object.assign(t, r);
  }
  async finishPost(id: string, status: string, publishedAt: Date | null) {
    Object.assign(this.posts.get(id)!, { status, publishedAt, publishingAt: null });
  }
  async dueIds(now: Date, limit: number) {
    return [...this.posts.values()].filter((p) => p.status === "SCHEDULED" && p.scheduledAt && p.scheduledAt <= now).slice(0, limit).map((p) => p.id);
  }
  async retry(tenantId: string, id: string, at: Date) {
    const p = this.posts.get(id);
    if (!p || p.tenantId !== tenantId || !["FAILED", "PARTIAL"].includes(p.status)) return false;
    Object.assign(p, { status: "SCHEDULED", scheduledAt: at });
    for (const t of p.targets) if (t.status === "FAILED") Object.assign(t, { status: "PENDING", error: null });
    return true;
  }
  async expireStale(before: Date) {
    let n = 0;
    for (const p of this.posts.values()) {
      if (p.status === "PUBLISHING" && p.publishingAt && p.publishingAt < before) {
        for (const t of p.targets) if (t.status === "PENDING") Object.assign(t, { status: "FAILED", error: "interrupted" });
        p.status = p.targets.some((t) => t.status === "PUBLISHED") ? "PARTIAL" : "FAILED";
        n++;
      }
    }
    return n;
  }
}

class FakePublisher implements SocialPublisher {
  calls: { account: PublishAccount; content: PublishContent }[] = [];
  failFor = new Map<string, Error>();
  async publish(account: PublishAccount, content: PublishContent) {
    this.calls.push({ account, content });
    const err = this.failFor.get(account.externalId);
    if (err) throw err;
    return { externalPostId: `post-${account.externalId}-${this.calls.length}`, permalink: `https://example.com/${account.externalId}` };
  }
}

const NOW = new Date("2026-10-28T10:00:00Z");

function setup() {
  const store = new MemoryStore();
  const publisher = new FakePublisher();
  let now = NOW;
  const service = new SocialPostService(store, publisher, () => "https://api.test", () => now);
  store.addAccount({ id: "fb1", platform: "FACEBOOK" });
  store.addAccount({ id: "ig1", platform: "INSTAGRAM" });
  store.addAccount({ id: "other", platform: "FACEBOOK", tenantId: "t2" });
  return { store, publisher, service, setNow: (d: Date) => (now = d) };
}

async function image(service: SocialPostService) {
  return service.uploadMedia("t1", "image/jpeg", Buffer.from("jpeg-bytes"));
}

describe("social token encryption", () => {
  it("round-trips and never stores the plain token", () => {
    const enc = encryptToken("EAAB-secret-token");
    expect(enc).not.toContain("EAAB");
    expect(decryptToken(enc)).toBe("EAAB-secret-token");
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });
  it("rejects a tampered token", () => {
    const enc = encryptToken("abc");
    const parts = enc.split(":");
    parts[3] = Buffer.from("xyz").toString("base64");
    expect(() => decryptToken(parts.join(":"))).toThrow();
  });
});

describe("SocialPostService", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => s.service.idle());

  it("publishes now to Facebook + Instagram with a public media URL", async () => {
    const m = await image(s.service);
    const post = await s.service.create("t1", "u1", { caption: "عرض اليوم", mediaId: m.id, accountIds: ["fb1", "ig1"], when: "now" });
    await s.service.idle();
    const after = await s.service.get("t1", post.id);
    expect(after.status).toBe("PUBLISHED");
    expect(after.targets.every((t) => t.status === "PUBLISHED" && t.permalink)).toBe(true);
    expect(s.publisher.calls).toHaveLength(2);
    const key = s.store.media.get(m.id)!.publicKey;
    expect(s.publisher.calls[0].content.media).toMatchObject({ kind: "image", mimeType: "image/jpeg", url: `https://api.test/api/public/social/media/${key}` });
    // التوكن بيوصل للمنصة مفكوك، ومتخزن متشفّر
    expect(s.publisher.calls[0].account.accessToken).toBe("token-fb1");
  });

  it("refuses Instagram without media, empty posts, and other companies' accounts", async () => {
    await expect(s.service.create("t1", null, { caption: "hi", mediaId: null, accountIds: ["ig1"], when: "now" })).rejects.toThrow(/Instagram needs a photo/);
    await expect(s.service.create("t1", null, { caption: "  ", mediaId: null, accountIds: ["fb1"], when: "now" })).rejects.toThrow(/Write something/);
    await expect(s.service.create("t1", null, { caption: "hi", mediaId: null, accountIds: ["other"], when: "now" })).rejects.toThrow(/isn't connected/);
    const foreign = await s.service.uploadMedia("t2", "image/png", Buffer.from("x"));
    await expect(s.service.create("t1", null, { caption: "hi", mediaId: foreign.id, accountIds: ["fb1"], when: "now" })).rejects.toThrow(/wasn't found/);
    expect(s.publisher.calls).toHaveLength(0);
  });

  it("text-only Facebook post works; Instagram caption limit enforced", async () => {
    const p = await s.service.create("t1", null, { caption: "Hello", mediaId: null, accountIds: ["fb1"], when: "now" });
    await s.service.idle();
    expect((await s.service.get("t1", p.id)).status).toBe("PUBLISHED");
    const m = await image(s.service);
    await expect(s.service.create("t1", null, { caption: "x".repeat(2201), mediaId: m.id, accountIds: ["ig1"], when: "now" })).rejects.toThrow(/2200/);
  });

  it("schedules: nothing before the time, publishes once when due, rejects past times", async () => {
    const m = await image(s.service);
    await expect(s.service.create("t1", null, { caption: "x", mediaId: m.id, accountIds: ["fb1"], when: "schedule", scheduledAt: new Date(NOW.getTime() - 5 * 60_000) })).rejects.toThrow(/past/);
    const p = await s.service.create("t1", null, { caption: "x", mediaId: m.id, accountIds: ["fb1"], when: "schedule", scheduledAt: new Date(NOW.getTime() + 3600_000) });
    expect(p.status).toBe("SCHEDULED");
    await s.service.runDue();
    expect(s.publisher.calls).toHaveLength(0);
    s.setNow(new Date(NOW.getTime() + 3601_000));
    await Promise.all([s.service.runDue(), s.service.runDue()]);
    expect(s.publisher.calls).toHaveLength(1);
    expect((await s.service.get("t1", p.id)).status).toBe("PUBLISHED");
  });

  it("partial failure → PARTIAL; retry republishes only the failed account", async () => {
    const m = await image(s.service);
    s.publisher.failFor.set("ext-ig1", new SocialPlatformError("Instagram couldn't process the file"));
    const p = await s.service.create("t1", null, { caption: "x", mediaId: m.id, accountIds: ["fb1", "ig1"], when: "now" });
    await s.service.idle();
    let after = await s.service.get("t1", p.id);
    expect(after.status).toBe("PARTIAL");
    expect(after.targets.find((t) => t.accountId === "ig1")!.error).toMatch(/couldn't process/);
    await expect(s.service.update("t1", p.id, { caption: "y", mediaId: m.id, accountIds: ["fb1"], when: "now" })).rejects.toThrow(/can't be edited/);

    s.publisher.failFor.clear();
    await s.service.retry("t1", p.id);
    await s.service.idle();
    after = await s.service.get("t1", p.id);
    expect(after.status).toBe("PUBLISHED");
    expect(s.publisher.calls.filter((c) => c.account.externalId === "ext-fb1")).toHaveLength(1);
    expect(s.publisher.calls.filter((c) => c.account.externalId === "ext-ig1")).toHaveLength(2);
  });

  it("an expired token marks the account NEEDS_RECONNECT and blocks new posts to it", async () => {
    s.publisher.failFor.set("ext-fb1", new SocialPlatformError("Session has expired", true));
    const p = await s.service.create("t1", null, { caption: "x", mediaId: null, accountIds: ["fb1"], when: "now" });
    await s.service.idle();
    expect((await s.service.get("t1", p.id)).status).toBe("FAILED");
    expect(s.store.accounts.get("fb1")!.status).toBe("NEEDS_RECONNECT");
    await expect(s.service.create("t1", null, { caption: "x", mediaId: null, accountIds: ["fb1"], when: "now" })).rejects.toThrow(/connected again/);
  });

  it("drafts are not published; interrupted posts become FAILED", async () => {
    const d = await s.service.create("t1", null, { caption: "draft", mediaId: null, accountIds: ["fb1"], when: "draft" });
    s.setNow(new Date(NOW.getTime() + 86400_000));
    await s.service.runDue();
    expect((await s.service.get("t1", d.id)).status).toBe("DRAFT");

    const stuck = await s.store.createPost({ tenantId: "t1", createdById: null, caption: "x", mediaId: null, status: "SCHEDULED", scheduledAt: NOW, options: null, accountIds: ["fb1"] });
    Object.assign(s.store.posts.get(stuck)!, { status: "PUBLISHING", publishingAt: NOW });
    const r = await s.service.runDue();
    expect(r.expired).toBe(1);
    expect((await s.service.get("t1", stuck)).status).toBe("FAILED");
  });

  it("media upload checks type and size; public lookup needs the exact key", async () => {
    await expect(s.service.uploadMedia("t1", "image/gif", Buffer.from("x"))).rejects.toThrow(/JPG or PNG/);
    await expect(s.service.uploadMedia("t1", "image/jpeg", Buffer.alloc(9 * 1024 * 1024))).rejects.toThrow(/too large/);
    const m = await image(s.service);
    const key = s.store.media.get(m.id)!.publicKey;
    expect(key).toMatch(/^[a-f0-9]{48}$/);
    expect(await s.service.mediaByKey(key)).not.toBeNull();
    expect(await s.service.mediaByKey("../etc")).toBeNull();
  });
});

describe("SocialAccountService", () => {
  it("saves discovered pages with encrypted tokens and warns when Instagram is missing", async () => {
    const store = new MemoryStore();
    const meta: MetaAccountConnector = {
      async discoverAccounts() {
        return [{ platform: "FACEBOOK", externalId: "p1", name: "Page", username: null, pictureUrl: null, parentId: null, accessToken: "PAGE-TOKEN", tokenExpiresAt: null }];
      },
    };
    const svc = new SocialAccountService(store, meta);
    const r = await svc.connectMeta("t1", "u1", { code: "abcd" });
    expect(r.accounts).toHaveLength(1);
    expect(r.warning).toMatch(/Instagram/);
    const saved = [...store.accounts.values()][0];
    expect(saved.accessToken).not.toContain("PAGE-TOKEN");
    expect(decryptToken(saved.accessToken)).toBe("PAGE-TOKEN");
  });

  it("no pages shared → clear 422", async () => {
    const svc = new SocialAccountService(new MemoryStore(), { discoverAccounts: async () => [] });
    await expect(svc.connectMeta("t1", null, { code: "abcd" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("MetaSocialGateway (request shapes)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.META_GRAPH_BASE_URL;
  });

  function mockGraph(handler: (method: string, path: string, body: any) => any) {
    const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
    process.env.META_GRAPH_BASE_URL = "https://graph.test/v21.0";
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const path = url.replace("https://graph.test/v21.0", "");
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init.method ?? "GET", path, body, auth: (init.headers as Record<string, string>)?.Authorization ?? null });
      const out = handler(init.method ?? "GET", path, body);
      return new Response(JSON.stringify(out), { status: out?.error ? 400 : 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return calls;
  }

  it("Instagram: container → wait → media_publish → permalink", async () => {
    let polls = 0;
    const calls = mockGraph((method, path) => {
      if (method === "POST" && path === "/ig1/media") return { id: "c1" };
      if (path.startsWith("/c1?")) return { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" };
      if (path === "/ig1/media_publish") return { id: "m1" };
      if (path.startsWith("/m1?")) return { permalink: "https://instagram.com/p/abc" };
      return { error: { message: "unexpected" } };
    });
    const g = new MetaSocialGateway({ pollMs: 1 });
    const r = await g.publish({ platform: "INSTAGRAM", externalId: "ig1", accessToken: "tok" }, { caption: "hi", media: { kind: "video", url: "https://api.test/v.mp4" } });
    expect(r).toEqual({ externalPostId: "m1", permalink: "https://instagram.com/p/abc" });
    expect(calls[0].body).toEqual({ media_type: "REELS", video_url: "https://api.test/v.mp4", caption: "hi", share_to_feed: true });
    expect(calls.find((c) => c.path === "/ig1/media_publish")!.body).toEqual({ creation_id: "c1" });
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("Facebook photo uses /photos with url + message; token error 190 asks to reconnect", async () => {
    const calls = mockGraph((_m, path) => (path === "/p1/photos" ? { id: "ph1", post_id: "p1_99" } : { error: { message: "Error validating access token", code: 190 } }));
    const g = new MetaSocialGateway();
    const r = await g.publish({ platform: "FACEBOOK", externalId: "p1", accessToken: "tok" }, { caption: "hi", media: { kind: "image", url: "https://api.test/i.jpg" } });
    expect(r.externalPostId).toBe("p1_99");
    expect(calls[0].body).toEqual({ url: "https://api.test/i.jpg", message: "hi" });
    await expect(g.publish({ platform: "FACEBOOK", externalId: "p2", accessToken: "tok" }, { caption: "hi", media: null })).rejects.toMatchObject({ needsReconnect: true });
  });

  it("discoverAccounts returns pages and their Instagram accounts", async () => {
    mockGraph((_m, path) => {
      if (path.startsWith("/me/accounts")) {
        return { data: [{ id: "p1", name: "Cafe", access_token: "PT", instagram_business_account: { id: "ig1", username: "cafe.qa" } }, { id: "p2", name: "Other", access_token: "PT2" }] };
      }
      return { error: { message: "no" } };
    });
    const list = await new MetaSocialGateway().discoverAccounts({ accessToken: "user-token" });
    expect(list.map((a) => `${a.platform}:${a.externalId}:${a.parentId ?? ""}`)).toEqual(["FACEBOOK:p1:", "INSTAGRAM:ig1:p1", "FACEBOOK:p2:"]);
    expect(list[1].accessToken).toBe("PT");
  });
});

describe("SocialPostService — TikTok rules", () => {
  const TT = { privacyLevel: "SELF_ONLY" as const, allowComment: true, allowDuet: false, allowStitch: false, brandOrganic: false, brandedContent: false };
  it("needs media + JPG photo + a chosen privacy; options reach the publisher with a loader for the bytes", async () => {
    const s = setup();
    s.store.addAccount({ id: "tt1", platform: "TIKTOK", username: "karak.qa" });
    const png = await s.service.uploadMedia("t1", "image/png", Buffer.from("png"));
    const video = await s.service.uploadMedia("t1", "video/mp4", Buffer.from("mp4-bytes"));
    await expect(s.service.create("t1", null, { caption: "x", mediaId: null, accountIds: ["tt1"], when: "now", options: { tiktok: TT } })).rejects.toThrow(/TikTok needs a video or a photo/);
    await expect(s.service.create("t1", null, { caption: "x", mediaId: png.id, accountIds: ["tt1"], when: "now", options: { tiktok: TT } })).rejects.toThrow(/must be JPG/);
    await expect(s.service.create("t1", null, { caption: "x", mediaId: video.id, accountIds: ["tt1"], when: "now" })).rejects.toThrow(/who can see/);
    await expect(s.service.create("t1", null, { caption: "x", mediaId: video.id, accountIds: ["tt1"], when: "now", options: { tiktok: { ...TT, brandedContent: true } } })).rejects.toThrow(/Branded content/);

    const p = await s.service.create("t1", null, { caption: "Reel", mediaId: video.id, accountIds: ["tt1", "fb1"], when: "now", options: { tiktok: TT } });
    await s.service.idle();
    expect((await s.service.get("t1", p.id)).status).toBe("PUBLISHED");
    const call = s.publisher.calls.find((c) => c.account.platform === "TIKTOK")!;
    expect(call.account.username).toBe("karak.qa");
    expect(call.content.options?.tiktok).toEqual(TT);
    expect((await call.content.media!.load!()).toString()).toBe("mp4-bytes");
  });

  it("an expiring TikTok token is refreshed before publishing", async () => {
    const store = new MemoryStore();
    const publisher = new FakePublisher();
    const refresh = vi.fn(async () => ({ accessToken: "fresh", tokenExpiresAt: new Date(NOW.getTime() + 86400_000), refreshToken: "rft2", refreshExpiresAt: null }));
    const { SocialTokenService } = await import("../modules/social/social-token.service");
    const service = new SocialPostService(store, publisher, () => "https://api.test", () => NOW, new SocialTokenService(store, { TIKTOK: { refresh } }, () => NOW));
    store.addAccount({ id: "tt1", platform: "TIKTOK", tokenExpiresAt: new Date(NOW.getTime() + 60_000), refreshToken: encryptToken("rft1") });
    const v = await service.uploadMedia("t1", "video/mp4", Buffer.from("v"));
    await service.create("t1", null, { caption: "x", mediaId: v.id, accountIds: ["tt1"], when: "now", options: { tiktok: TT } });
    await service.idle();
    expect(refresh).toHaveBeenCalledWith("rft1");
    expect(publisher.calls[0].account.accessToken).toBe("fresh");
    expect(store.tokenWrites).toHaveLength(1);
  });
});
