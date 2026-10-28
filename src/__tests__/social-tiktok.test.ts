import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { TikTokGateway } from "../modules/social/tiktok.gateway";
import { SocialTokenService } from "../modules/social/social-token.service";
import { SocialAccountService } from "../modules/social/social-account.service";
import { decryptToken, encryptToken } from "../modules/social/token-crypto";
import type { DiscoveredAccount, TikTokConnector } from "../modules/social/social-types";

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const OPTS = { privacyLevel: "SELF_ONLY", allowComment: true, allowDuet: false, allowStitch: false, brandOrganic: true, brandedContent: false };

describe("TikTokGateway (request shapes, fake fetch)", () => {
  const realFetch = globalThis.fetch;
  type Call = { method: string; url: string; headers: Record<string, string>; body: any };
  let calls: Call[];
  let handler: (c: Call) => { status?: number; json?: unknown };

  beforeEach(() => {
    process.env.TIKTOK_CLIENT_KEY = "ck_test";
    process.env.TIKTOK_CLIENT_SECRET = "cs_test";
    process.env.TIKTOK_API_BASE_URL = "https://tt.test";
    calls = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const ct = headers["Content-Type"] ?? "";
      const raw = init.body;
      const body = ct.startsWith("application/json") ? JSON.parse(String(raw)) : ct.startsWith("application/x-www-form") ? Object.fromEntries(new URLSearchParams(String(raw))) : raw;
      const c = { method: init.method ?? "GET", url, headers, body };
      calls.push(c);
      const r = handler(c);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_API_BASE_URL"]) delete process.env[k];
  });

  it("authorize URL carries client key, scopes, redirect and state", () => {
    const u = new URL(new TikTokGateway().authorizeUrl("st4te", "https://api.test/cb"));
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_key: "ck_test", scope: "user.info.basic,video.publish,video.upload", response_type: "code", redirect_uri: "https://api.test/cb", state: "st4te" });
  });

  it("code → tokens (form body) → user info → account with refresh token", async () => {
    handler = (c) => {
      if (c.url.endsWith("/v2/oauth/token/")) return { json: { access_token: "act.1", expires_in: 86400, refresh_token: "rft.1", refresh_expires_in: 31536000, open_id: "open_1", scope: "video.publish" } };
      if (c.url.includes("/v2/user/info/")) return { json: { data: { user: { open_id: "open_1", display_name: "Karak Cafe", username: "karak.qa", avatar_url: "https://p.tt/a.jpg" } }, error: { code: "ok" } } };
      return { status: 404 };
    };
    const a = await new TikTokGateway().exchangeCode("code123", "https://api.test/cb");
    expect(calls[0].body).toEqual({ client_key: "ck_test", client_secret: "cs_test", code: "code123", grant_type: "authorization_code", redirect_uri: "https://api.test/cb" });
    expect(calls[1].headers.Authorization).toBe("Bearer act.1");
    expect(a).toMatchObject({ platform: "TIKTOK", externalId: "open_1", name: "Karak Cafe", username: "karak.qa", accessToken: "act.1", refreshToken: "rft.1" });
    expect(a.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86000_000);
  });

  it("video: FILE_UPLOAD init → PUT with Content-Range → status until complete → permalink", async () => {
    let polls = 0;
    handler = (c) => {
      if (c.url.endsWith("/v2/post/publish/video/init/")) return { json: { data: { publish_id: "v_pub_1", upload_url: "https://upload.tt/vid?x=1" }, error: { code: "ok" } } };
      if (c.url.startsWith("https://upload.tt/")) return { status: 201 };
      if (c.url.endsWith("/v2/post/publish/status/fetch/")) return { json: { data: ++polls < 2 ? { status: "PROCESSING_UPLOAD" } : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7123] }, error: { code: "ok" } } };
      return { status: 404 };
    };
    const bytes = Buffer.alloc(3000, 1);
    const r = await new TikTokGateway({ pollMs: 1 }).publish(
      { platform: "TIKTOK", externalId: "open_1", username: "karak.qa", accessToken: "act.1" },
      { caption: "كرك 🔥 #قطر", media: { kind: "video", url: "https://api.test/m", mimeType: "video/mp4", load: async () => bytes }, options: { tiktok: OPTS } }
    );
    const init = calls[0].body;
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 3000, chunk_size: 3000, total_chunk_count: 1 });
    expect(init.post_info).toEqual({ privacy_level: "SELF_ONLY", disable_comment: false, brand_organic_toggle: true, brand_content_toggle: false, title: "كرك 🔥 #قطر", disable_duet: true, disable_stitch: true });
    expect(calls[1]).toMatchObject({ method: "PUT", url: "https://upload.tt/vid?x=1" });
    expect(calls[1].headers["Content-Range"]).toBe("bytes 0-2999/3000");
    expect(r).toEqual({ externalPostId: "7123", permalink: "https://www.tiktok.com/@karak.qa/video/7123" });
  });

  it("photo: PULL_FROM_URL with short title; private post without public id → no link", async () => {
    handler = (c) => {
      if (c.url.endsWith("/v2/post/publish/content/init/")) return { json: { data: { publish_id: "p_pub_1" }, error: { code: "ok" } } };
      if (c.url.endsWith("/status/fetch/")) return { json: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } };
      return { status: 404 };
    };
    const caption = "x".repeat(150);
    const r = await new TikTokGateway({ pollMs: 1 }).publish({ platform: "TIKTOK", externalId: "o", accessToken: "t" }, { caption, media: { kind: "image", url: "https://api.test/p.jpg" }, options: { tiktok: OPTS } });
    expect(calls[0].body).toMatchObject({ media_type: "PHOTO", post_mode: "DIRECT_POST", source_info: { source: "PULL_FROM_URL", photo_images: ["https://api.test/p.jpg"], photo_cover_index: 0 } });
    expect(calls[0].body.post_info.title).toHaveLength(90);
    expect(calls[0].body.post_info.description).toHaveLength(150);
    expect(r).toEqual({ externalPostId: "p_pub_1", permalink: null });
  });

  it("errors: unaudited app → friendly text; invalid token → reconnect; FAILED status → reason", async () => {
    const g = new TikTokGateway({ pollMs: 1 });
    const acc = { platform: "TIKTOK" as const, externalId: "o", accessToken: "t" };
    const content = { caption: "x", media: { kind: "image" as const, url: "u" }, options: { tiktok: { ...OPTS, privacyLevel: "PUBLIC_TO_EVERYONE" } } };
    handler = () => ({ status: 403, json: { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "..." } } });
    await expect(g.publish(acc, content)).rejects.toThrow(/Only me/);
    handler = () => ({ status: 401, json: { error: { code: "access_token_invalid", message: "expired" } } });
    await expect(g.publish(acc, content)).rejects.toMatchObject({ needsReconnect: true });
    handler = (c) => (c.url.endsWith("/init/") ? { json: { data: { publish_id: "z" }, error: { code: "ok" } } } : { json: { data: { status: "FAILED", fail_reason: "picture_size_check_failed" }, error: { code: "ok" } } });
    await expect(g.publish(acc, content)).rejects.toThrow(/picture_size_check_failed/);
    await expect(g.publish(acc, { ...content, options: {} })).rejects.toThrow(/who can see/);
  });
});

describe("SocialTokenService", () => {
  const NOW = new Date("2026-10-28T12:00:00Z");
  it("refreshes a TikTok token that expires soon and stores the new ones encrypted", async () => {
    const writes: any[] = [];
    const refresher = { refresh: vi.fn(async (rt: string) => ({ accessToken: `new-for-${rt}`, tokenExpiresAt: new Date(NOW.getTime() + 86400_000), refreshToken: "rft.2", refreshExpiresAt: null })) };
    const svc = new SocialTokenService({ updateTokens: async (_id, t) => void writes.push(t) }, { TIKTOK: refresher }, () => NOW);
    const base = { id: "a1", platform: "TIKTOK" as const, accessToken: encryptToken("old"), refreshToken: encryptToken("rft.1") };
    expect(await svc.accessToken({ ...base, tokenExpiresAt: new Date(NOW.getTime() + 3600_000) })).toBe("old");
    expect(refresher.refresh).not.toHaveBeenCalled();
    expect(await svc.accessToken({ ...base, tokenExpiresAt: new Date(NOW.getTime() + 60_000) })).toBe("new-for-rft.1");
    expect(decryptToken(writes[0].accessToken)).toBe("new-for-rft.1");
    expect(decryptToken(writes[0].refreshToken)).toBe("rft.2");
    // Meta: مفيش تجديد
    expect(await svc.accessToken({ ...base, platform: "FACEBOOK", tokenExpiresAt: null })).toBe("old");
  });
});

describe("SocialAccountService — TikTok connect", () => {
  const NOW = new Date("2026-10-28T12:00:00Z");
  function setup(now = NOW) {
    const saved: { tenantId: string; list: DiscoveredAccount[] }[] = [];
    const store: any = { upsertAccounts: async (tenantId: string, _u: string | null, list: DiscoveredAccount[]) => void saved.push({ tenantId, list }) };
    const connector: TikTokConnector = {
      enabled: true,
      authorizeUrl: (state, redirect) => `https://tiktok.test/auth?state=${state}&redirect=${encodeURIComponent(redirect)}`,
      exchangeCode: vi.fn(async () => ({ platform: "TIKTOK", externalId: "open_1", name: "Karak", username: "karak.qa", pictureUrl: null, parentId: null, accessToken: "act", tokenExpiresAt: null, refreshToken: "rft", refreshExpiresAt: null })) as any,
      refresh: vi.fn() as any,
      creatorInfo: vi.fn() as any,
    };
    let clock = now;
    const svc = new SocialAccountService(store, { discoverAccounts: async () => [] }, { tiktok: connector, publicApiBaseUrl: () => "https://api.test", frontendBaseUrl: () => "https://app.test", now: () => clock });
    return { svc, saved, connector, setClock: (d: Date) => (clock = d) };
  }
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

  it("connect URL → callback saves the account for that company with encrypted tokens", async () => {
    const { svc, saved, connector } = setup();
    const { url } = svc.tiktokConnectUrl("t1", "u1");
    expect(url).toContain(encodeURIComponent("https://api.test/api/public/social/tiktok/callback"));
    const back = await svc.tiktokCallback({ code: "c1", state: stateOf(url) });
    expect(back).toBe("https://app.test/ai-studio?tool=publish&tiktok=connected");
    expect(connector.exchangeCode).toHaveBeenCalledWith("c1", "https://api.test/api/public/social/tiktok/callback");
    expect(saved[0].tenantId).toBe("t1");
    expect(decryptToken(saved[0].list[0].accessToken)).toBe("act");
    expect(decryptToken(saved[0].list[0].refreshToken!)).toBe("rft");
  });

  it("tampered / expired state or cancel → back to the app with an error, nothing saved", async () => {
    const { svc, saved, setClock } = setup();
    expect(await svc.tiktokCallback({ code: "c", state: "not-a-real-state" })).toMatch(/tiktok_error=/);
    const state = stateOf(svc.tiktokConnectUrl("t1", "u1").url);
    expect(decodeURIComponent(await svc.tiktokCallback({ error: "access_denied", state }))).toMatch(/cancelled/);
    setClock(new Date(NOW.getTime() + 16 * 60_000));
    expect(decodeURIComponent((await svc.tiktokCallback({ code: "c", state })).replace(/\+/g, " "))).toMatch(/expired/);
    expect(saved).toHaveLength(0);
  });

  it("not configured → 503", () => {
    const svc = new SocialAccountService({} as any, { discoverAccounts: async () => [] });
    expect(() => svc.tiktokConnectUrl("t1", null)).toThrow(/isn't switched on/);
    expect(svc.config().tiktok.enabled).toBe(false);
  });
});
