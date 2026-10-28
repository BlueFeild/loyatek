import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { SocialAdsService } from "../modules/social/ads.service";
import { MetaAdsGateway } from "../modules/social/meta-ads.gateway";
import { statusFromMeta, toMinorUnits, type AdAccountInfo, type AdsPlatform, type BoostSpec } from "../modules/social/ads-types";
import type { AdCampaignPatch, AdCampaignRow, AdEventView, AdsStore, BoostTarget, NewAdCampaign, StoredAdsAuth } from "../modules/social/ads.repository";
import { SocialAccountService } from "../modules/social/social-account.service";
import { SocialPlatformError } from "../modules/social/social-types";
import { decryptToken, encryptToken } from "../modules/social/token-crypto";

process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";

const T1 = "tenant-1";
const T2 = "tenant-2";
const FB_TARGET = "11111111-1111-4111-8111-111111111111";
const IG_TARGET = "22222222-2222-4222-8222-222222222222";
const DRAFT_TARGET = "33333333-3333-4333-8333-333333333333";

class MemoryAdsStore implements AdsStore {
  auth = new Map<string, StoredAdsAuth>();
  targets = new Map<string, BoostTarget & { tenantId: string }>();
  campaigns: AdCampaignRow[] = [];
  eventsLog: (AdEventView & { tenantId: string; campaignId: string })[] = [];

  async saveAuth(tenantId: string, a: StoredAdsAuth & { connectedById: string | null }) {
    this.auth.set(tenantId, { accessToken: a.accessToken, tokenExpiresAt: a.tokenExpiresAt });
  }
  async getAuth(tenantId: string) {
    return this.auth.get(tenantId) ?? null;
  }
  async boostTarget(tenantId: string, id: string) {
    const t = this.targets.get(id);
    return t && t.tenantId === tenantId ? t : null;
  }
  async creatingSince(tenantId: string, postExternalId: string, since: Date) {
    return this.campaigns.some((c) => c.tenantId === tenantId && c.postExternalId === postExternalId && c.status === "CREATING" && c.createdAt >= since);
  }
  async createCampaign(c: NewAdCampaign) {
    const id = `camp-${this.campaigns.length + 1}`;
    this.campaigns.push({
      ...c,
      id,
      accountName: "Page",
      status: "CREATING",
      metaStatus: null,
      reviewFeedback: null,
      error: null,
      metaCampaignId: null,
      metaAdSetId: null,
      metaAdId: null,
      impressions: 0,
      reach: 0,
      clicks: 0,
      engagements: 0,
      spend: 0,
      syncedAt: null,
      createdAt: new Date(),
    });
    return id;
  }
  async updateCampaign(id: string, patch: AdCampaignPatch) {
    const c = this.campaigns.find((x) => x.id === id)!;
    const { metaCreativeId: _ignored, ...rest } = patch;
    Object.assign(c, rest);
  }
  async getCampaign(tenantId: string, id: string) {
    const c = this.campaigns.find((x) => x.id === id && x.tenantId === tenantId);
    return c ? { ...c } : null;
  }
  async listCampaigns(tenantId: string) {
    return this.campaigns.filter((c) => c.tenantId === tenantId).map((c) => ({ ...c }));
  }
  async addEvent(e: { tenantId: string; campaignId: string; userId: string | null; action: string; details?: Record<string, unknown> }) {
    this.eventsLog.push({ ...e, details: e.details ?? null, createdAt: new Date() });
  }
  async events(tenantId: string, campaignId: string) {
    return this.eventsLog.filter((e) => e.tenantId === tenantId && e.campaignId === campaignId);
  }
}

class FakeAdsPlatform implements AdsPlatform {
  accounts: AdAccountInfo[] = [
    { id: "act_100", name: "Café ads", currency: "QAR", active: true, statusText: "Active" },
    { id: "act_200", name: "Old account", currency: "USD", active: false, statusText: "Disabled" },
  ];
  boosts: { token: string; spec: BoostSpec }[] = [];
  statusCalls: string[] = [];
  budgetCalls: number[] = [];
  failWith: Error | null = null;
  state = { metaStatus: "ACTIVE", reviewFeedback: null as string | null };
  insightsCalls = 0;

  async listAdAccounts() {
    return this.accounts;
  }
  async searchCities() {
    return [{ key: "1", name: "Doha", country: "QA" }];
  }
  async createBoost(token: string, spec: BoostSpec) {
    if (this.failWith) throw this.failWith;
    this.boosts.push({ token, spec });
    return { campaignId: "c1", adSetId: "s1", creativeId: "cr1", adId: "a1" };
  }
  async setStatus(_t: string, id: string, status: string) {
    this.statusCalls.push(`${id}:${status}`);
  }
  async setDailyBudget(_t: string, _id: string, minor: number) {
    this.budgetCalls.push(minor);
  }
  async getState() {
    return this.state;
  }
  async getInsights() {
    this.insightsCalls++;
    return { impressions: 5000, reach: 3200, clicks: 140, engagements: 410, spend: 55.5 };
  }
}

const TARGETING = { countries: ["QA"], cities: [], ageMin: 20, ageMax: 45, gender: "women" as const };

function setup(nowRef = { now: new Date("2026-11-01T10:00:00Z") }) {
  const store = new MemoryAdsStore();
  const platform = new FakeAdsPlatform();
  store.auth.set(T1, { accessToken: encryptToken("user-token-1"), tokenExpiresAt: new Date("2026-12-30T00:00:00Z") });
  const base = { status: "PUBLISHED", permalink: "https://fb.test/p", caption: "New iced latte", accountName: "Café", accountStatus: "ACTIVE" };
  store.targets.set(FB_TARGET, { ...base, tenantId: T1, targetId: FB_TARGET, externalPostId: "900_777", accountId: "acc-fb", platform: "FACEBOOK", accountExternalId: "900", accountParentId: null });
  store.targets.set(IG_TARGET, { ...base, tenantId: T1, targetId: IG_TARGET, externalPostId: "1789", accountId: "acc-ig", platform: "INSTAGRAM", accountExternalId: "17840", accountParentId: "900" });
  store.targets.set(DRAFT_TARGET, { ...base, tenantId: T1, targetId: DRAFT_TARGET, status: "PENDING", externalPostId: null, accountId: "acc-fb", platform: "FACEBOOK", accountExternalId: "900", accountParentId: null });
  // سعر الريال 3.64 → الحد 100$ = 364 ريال، والأقل 1$ = 3.64 ريال
  const service = new SocialAdsService(store, platform, {
    limits: async () => ({ maxDailyBudgetUsd: 100, maxDays: 30 }),
    rates: async () => ({ USD: 1, QAR: 3.64 }),
    now: () => nowRef.now,
  });
  return { store, platform, service, nowRef };
}

const boostInput = (over: Record<string, unknown> = {}) => ({
  targetId: FB_TARGET,
  adAccountId: "act_100",
  objective: "REACH" as const,
  dailyBudget: 50,
  days: 7,
  targeting: TARGETING,
  confirmedTotal: 350,
  ...over,
});

describe("SocialAdsService.boost", () => {
  it("creates the boost at Meta with the budget in minor units and records who did it", async () => {
    const { service, platform, store } = setup();
    const c = await service.boost(T1, "user-1", boostInput());
    expect(c.status).toBe("PENDING_REVIEW");
    expect(c.currency).toBe("QAR");
    expect(c.maxTotal).toBe(350);
    expect(c.days).toBe(7);
    expect(platform.boosts).toHaveLength(1);
    const { token, spec } = platform.boosts[0];
    expect(token).toBe("user-token-1");
    expect(spec).toMatchObject({ adAccountId: "act_100", dailyBudgetMinor: 5000, pageId: "900", instagramUserId: null, postExternalId: "900_777", platform: "FACEBOOK" });
    expect(spec.endAt.getTime() - spec.startAt.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(store.eventsLog.map((e) => [e.action, e.userId])).toEqual([["CREATED", "user-1"]]);
    expect(store.eventsLog[0].details).toMatchObject({ total: 350, currency: "QAR", days: 7 });
  });

  it("boosts an Instagram post through its linked Facebook Page", async () => {
    const { service, platform } = setup();
    await service.boost(T1, "user-1", boostInput({ targetId: IG_TARGET }));
    expect(platform.boosts[0].spec).toMatchObject({ platform: "INSTAGRAM", pageId: "900", instagramUserId: "17840", postExternalId: "1789" });
  });

  it("refuses when the confirmed total doesn't match (nothing is sent to Meta)", async () => {
    const { service, platform, store } = setup();
    await expect(service.boost(T1, "u", boostInput({ confirmedTotal: 50 }))).rejects.toThrow(/confirm the total again: 350 QAR/);
    expect(platform.boosts).toHaveLength(0);
    expect(store.campaigns).toHaveLength(0);
  });

  it("enforces the platform's daily budget limit, the minimum and the max days", async () => {
    const { service, platform } = setup();
    await expect(service.boost(T1, "u", boostInput({ dailyBudget: 365, days: 1, confirmedTotal: 365 }))).rejects.toThrow(/can't be more than 364 QAR/);
    await expect(service.boost(T1, "u", boostInput({ dailyBudget: 3, days: 1, confirmedTotal: 3 }))).rejects.toThrow(/at least 3.64 QAR/);
    await expect(service.boost(T1, "u", boostInput({ dailyBudget: 10, days: 31, confirmedTotal: 310 }))).rejects.toThrow(/between 1 and 30 days/);
    expect(platform.boosts).toHaveLength(0);
    // على الحد بالظبط = مسموح
    await expect(service.boost(T1, "u", boostInput({ dailyBudget: 364, days: 1, confirmedTotal: 364 }))).resolves.toBeTruthy();
  });

  it("only boosts this company's published posts", async () => {
    const { service } = setup();
    await expect(service.boost(T2, "u", boostInput())).rejects.toThrow(/Post not found/);
    await expect(service.boost(T1, "u", boostInput({ targetId: DRAFT_TARGET }))).rejects.toThrow(/Only a published post/);
  });

  it("refuses unknown or disabled ad accounts", async () => {
    const { service } = setup();
    await expect(service.boost(T1, "u", boostInput({ adAccountId: "act_999" }))).rejects.toThrow(/isn't available/);
    await expect(service.boost(T1, "u", boostInput({ adAccountId: "act_200" }))).rejects.toThrow(/can't run ads right now \(Disabled\)/);
  });

  it("asks to reconnect when there is no ads connection or it expired", async () => {
    const { service, store, nowRef } = setup();
    store.auth.delete(T1);
    await expect(service.boost(T1, "u", boostInput())).rejects.toMatchObject({ status: 409, code: "ADS_RECONNECT" });
    store.auth.set(T1, { accessToken: encryptToken("t"), tokenExpiresAt: new Date(nowRef.now.getTime() - 1000) });
    await expect(service.boost(T1, "u", boostInput())).rejects.toMatchObject({ code: "ADS_RECONNECT" });
  });

  it("records a failed boost (FAILED + reason) and explains a missing ads permission", async () => {
    const { service, platform, store } = setup();
    platform.failWith = new SocialPlatformError("Your post can't be boosted because it has music", false, 100);
    await expect(service.boost(T1, "u", boostInput())).rejects.toThrow(/music/);
    expect(store.campaigns[0]).toMatchObject({ status: "FAILED", error: "Your post can't be boosted because it has music" });
    expect(store.eventsLog.map((e) => e.action)).toEqual(["FAILED"]);

    platform.failWith = new SocialPlatformError("(#200) Requires ads_management permission", false, 200);
    await expect(service.boost(T1, "u", boostInput())).rejects.toMatchObject({ code: "ADS_RECONNECT" });
  });

  it("blocks a double click while the same post is still being created", async () => {
    const { service, store, nowRef } = setup();
    await store.createCampaign({ tenantId: T1, accountId: "acc-fb", platform: "FACEBOOK", postExternalId: "900_777", permalink: null, caption: null, adAccountId: "act_100", adAccountName: null, currency: "QAR", objective: "REACH", dailyBudget: 50, startAt: new Date(), endAt: new Date(), targeting: TARGETING, createdById: null });
    store.campaigns[0].createdAt = new Date(nowRef.now.getTime() - 60 * 1000);
    await expect(service.boost(T1, "u", boostInput())).rejects.toMatchObject({ status: 409, code: "BOOST_IN_PROGRESS" });
  });
});

describe("SocialAdsService pause / resume / budget / refresh", () => {
  async function running() {
    const ctx = setup();
    const c = await ctx.service.boost(T1, "owner", boostInput());
    return { ...ctx, id: c.id };
  }

  it("pauses and resumes at Meta and logs both", async () => {
    const { service, platform, store, id } = await running();
    platform.state = { metaStatus: "CAMPAIGN_PAUSED", reviewFeedback: null };
    expect((await service.pause(T1, "owner", id)).status).toBe("PAUSED");
    await expect(service.pause(T1, "owner", id)).rejects.toThrow(/Only a running ad/);
    platform.state = { metaStatus: "ACTIVE", reviewFeedback: null };
    expect((await service.resume(T1, "owner", id)).status).toBe("ACTIVE");
    expect(platform.statusCalls).toEqual(["c1:PAUSED", "c1:ACTIVE"]);
    expect(store.eventsLog.map((e) => e.action)).toEqual(["CREATED", "PAUSED", "RESUMED"]);
  });

  it("doesn't resume an ad whose end date passed", async () => {
    const { service, platform, nowRef, id } = await running();
    platform.state = { metaStatus: "CAMPAIGN_PAUSED", reviewFeedback: null };
    await service.pause(T1, "owner", id);
    nowRef.now = new Date(nowRef.now.getTime() + 8 * 24 * 3600 * 1000);
    await expect(service.resume(T1, "owner", id)).rejects.toThrow(/end date has passed/);
  });

  it("changes the daily budget within the limit only", async () => {
    const { service, platform, store, id } = await running();
    await expect(service.changeBudget(T1, "owner", id, 500)).rejects.toThrow(/can't be more than 364 QAR/);
    const c = await service.changeBudget(T1, "owner", id, 80);
    expect(c.dailyBudget).toBe(80);
    expect(platform.budgetCalls).toEqual([8000]);
    expect(store.eventsLog.at(-1)).toMatchObject({ action: "BUDGET_CHANGED", details: { from: 50, to: 80, currency: "QAR" } });
  });

  it("another company can't touch the ad", async () => {
    const { service, id } = await running();
    await expect(service.pause(T2, "x", id)).rejects.toThrow(/Ad not found/);
    await expect(service.get(T2, id)).rejects.toThrow(/Ad not found/);
  });

  it("refreshes status and results from Meta at most every 10 minutes", async () => {
    const { service, platform, nowRef } = await running();
    platform.state = { metaStatus: "DISAPPROVED", reviewFeedback: "Too much text" };
    // لسه متحدّث دلوقتي → مايسألش Meta
    let r = await service.list(T1);
    expect(platform.insightsCalls).toBe(0);
    expect(r.campaigns[0].status).toBe("PENDING_REVIEW");
    nowRef.now = new Date(nowRef.now.getTime() + 11 * 60 * 1000);
    r = await service.list(T1);
    expect(platform.insightsCalls).toBe(1);
    expect(r.campaigns[0]).toMatchObject({ status: "REJECTED", reviewFeedback: "Too much text", reach: 3200, spend: 55.5, clicks: 140 });
    expect(r.overview.connected).toBe(true);
  });
});

describe("ads helpers", () => {
  it("maps Meta's effective_status to what the merchant sees", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const later = new Date("2026-11-05T00:00:00Z");
    const before = new Date("2026-10-30T00:00:00Z");
    expect(statusFromMeta("ACTIVE", later, now)).toBe("ACTIVE");
    expect(statusFromMeta("ACTIVE", before, now)).toBe("COMPLETED");
    expect(statusFromMeta("CAMPAIGN_PAUSED", later, now)).toBe("PAUSED");
    expect(statusFromMeta("IN_PROCESS", later, now)).toBe("PENDING_REVIEW");
    expect(statusFromMeta("DISAPPROVED", later, now)).toBe("REJECTED");
    expect(statusFromMeta("PENDING_BILLING_INFO", later, now)).toBe("ISSUE");
    expect(toMinorUnits(12.345)).toBe(1235);
  });

  it("Connect Facebook & Instagram stores the long-lived user token for ads (encrypted)", async () => {
    const saved: { tenantId: string; token: string }[] = [];
    const meta = {
      discoverAccounts: async () => [],
      connect: async () => ({
        accounts: [{ platform: "FACEBOOK" as const, externalId: "900", name: "Café", username: null, pictureUrl: null, parentId: null, accessToken: "page-token", tokenExpiresAt: null }],
        userToken: "long-user-token",
        userTokenExpiresAt: new Date("2027-01-01T00:00:00Z"),
      }),
    };
    const socialStore = { upsertAccounts: async () => {}, listAccounts: async () => [] } as any;
    const service = new SocialAccountService(socialStore, meta, { adsAuth: { saveConnection: async (tenantId, _u, token) => void saved.push({ tenantId, token }) } });
    await service.connectMeta(T1, "owner", { code: "abcdef" });
    expect(saved).toEqual([{ tenantId: T1, token: "long-user-token" }]);

    // والخدمة بتحفظه متشفّر
    const store = new MemoryAdsStore();
    const ads = new SocialAdsService(store, new FakeAdsPlatform(), { limits: async () => ({ maxDailyBudgetUsd: 100, maxDays: 30 }), rates: async () => ({ USD: 1 }) });
    await ads.saveConnection(T1, "owner", "long-user-token", null);
    const stored = store.auth.get(T1)!.accessToken;
    expect(stored).not.toContain("long-user-token");
    expect(decryptToken(stored)).toBe("long-user-token");
  });
});

describe("MetaAdsGateway (request shapes, fake fetch)", () => {
  const realFetch = globalThis.fetch;
  type Call = { method: string; url: string; body: any; auth: string | undefined };
  let calls: Call[];
  let handler: (c: Call) => { status?: number; json?: unknown };

  beforeEach(() => {
    process.env.META_GRAPH_BASE_URL = "https://graph.test";
    calls = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const c = { method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization };
      calls.push(c);
      const r = handler(c);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.META_GRAPH_BASE_URL;
  });

  const spec = (over: Partial<BoostSpec> = {}): BoostSpec => ({
    adAccountId: "act_100",
    name: "BlueField boost",
    objective: "ENGAGEMENT",
    platform: "FACEBOOK",
    pageId: "900",
    instagramUserId: null,
    postExternalId: "900_777",
    caption: "Hi",
    dailyBudgetMinor: 5000,
    startAt: new Date("2026-11-01T10:00:00Z"),
    endAt: new Date("2026-11-08T10:00:00Z"),
    targeting: { countries: ["QA"], cities: [], ageMin: 20, ageMax: 45, gender: "women" },
    ...over,
  });

  function okIds(c: Call) {
    if (c.url.endsWith("/act_100/campaigns")) return { json: { id: "c1" } };
    if (c.url.endsWith("/act_100/adsets")) return { json: { id: "s1" } };
    if (c.url.endsWith("/act_100/adcreatives")) return { json: { id: "cr1" } };
    if (c.url.endsWith("/act_100/ads")) return { json: { id: "a1" } };
    if (c.url.includes("fields=picture")) return { json: { picture: "https://cdn.test/thumb.jpg" } };
    return { json: { success: true } };
  }

  it("creates campaign (paused) → ad set → creative from the post → ad → then starts the campaign", async () => {
    handler = okIds;
    const ids = await new MetaAdsGateway().createBoost("user-token", spec());
    expect(ids).toEqual({ campaignId: "c1", adSetId: "s1", creativeId: "cr1", adId: "a1" });
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://graph.test", "")}`)).toEqual([
      "POST /act_100/campaigns",
      "POST /act_100/adsets",
      "POST /act_100/adcreatives",
      "POST /act_100/ads",
      "POST /c1",
    ]);
    expect(calls.every((c) => c.auth === "Bearer user-token")).toBe(true);
    expect(calls[0].body).toMatchObject({ objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", special_ad_categories: [] });
    expect(calls[1].body).toMatchObject({
      campaign_id: "c1",
      daily_budget: 5000,
      optimization_goal: "POST_ENGAGEMENT",
      billing_event: "IMPRESSIONS",
      start_time: "2026-11-01T10:00:00.000Z",
      end_time: "2026-11-08T10:00:00.000Z",
      targeting: { geo_locations: { countries: ["QA"] }, age_min: 20, age_max: 45, genders: [2], publisher_platforms: ["facebook"], targeting_automation: { advantage_audience: 0 } },
    });
    expect(calls[2].body).toMatchObject({ object_story_id: "900_777" });
    expect(calls[3].body).toMatchObject({ adset_id: "s1", creative: { creative_id: "cr1" }, status: "ACTIVE" });
    expect(calls[4].body).toEqual({ status: "ACTIVE" });
  });

  it("deletes the half-made campaign when a later step fails", async () => {
    handler = (c) => (c.url.endsWith("/adsets") ? { status: 400, json: { error: { message: "Invalid targeting", code: 100 } } } : okIds(c));
    await expect(new MetaAdsGateway().createBoost("t", spec())).rejects.toThrow(/Invalid targeting/);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://graph.test/c1" });
  });

  it("uses the video itself for a Facebook video post, and the media id for Instagram; cities replace countries", async () => {
    handler = okIds;
    await new MetaAdsGateway().createBoost("t", spec({ postExternalId: "555", objective: "REACH" }));
    expect(calls.find((c) => c.url.endsWith("/adcreatives"))!.body).toMatchObject({
      object_story_spec: { page_id: "900", video_data: { video_id: "555", image_url: "https://cdn.test/thumb.jpg", message: "Hi" } },
    });
    expect(calls.find((c) => c.url.endsWith("/campaigns"))!.body.objective).toBe("OUTCOME_AWARENESS");
    calls = [];
    await new MetaAdsGateway().createBoost("t", spec({ platform: "INSTAGRAM", instagramUserId: "17840", postExternalId: "1789", targeting: { countries: ["QA"], cities: [{ key: "2", name: "Doha" }], ageMin: 18, ageMax: 65, gender: "all" } }));
    expect(calls.find((c) => c.url.endsWith("/adcreatives"))!.body).toMatchObject({ object_id: "900", instagram_user_id: "17840", source_instagram_media_id: "1789" });
    const targeting = calls.find((c) => c.url.endsWith("/adsets"))!.body.targeting;
    expect(targeting.geo_locations).toEqual({ cities: [{ key: "2" }] });
    expect(targeting.publisher_platforms).toEqual(["instagram"]);
    expect(targeting.genders).toBeUndefined();
  });

  it("lists ad accounts with their currency and whether they can run ads", async () => {
    handler = () => ({ json: { data: [{ id: "act_100", name: "Café", currency: "qar", account_status: 1 }, { id: "200", name: "Old", currency: "USD", account_status: 3 }] } });
    const list = await new MetaAdsGateway().listAdAccounts("t");
    expect(list).toEqual([
      { id: "act_100", name: "Café", currency: "QAR", active: true, statusText: "Active" },
      { id: "act_200", name: "Old", currency: "USD", active: false, statusText: "Unpaid balance — settle it in Meta Ads Manager" },
    ]);
  });

  it("reads review feedback and results", async () => {
    handler = (c) =>
      c.url.includes("/insights")
        ? { json: { data: [{ impressions: "1200", reach: "900", clicks: "33", spend: "12.40", inline_post_engagement: "80" }] } }
        : { json: { effective_status: "DISAPPROVED", ad_review_feedback: { global: { "Text policy": "Your ad has too much text" } } } };
    const g = new MetaAdsGateway();
    expect(await g.getState("t", "a1")).toEqual({ metaStatus: "DISAPPROVED", reviewFeedback: "Your ad has too much text" });
    expect(await g.getInsights("t", "c1")).toEqual({ impressions: 1200, reach: 900, clicks: 33, engagements: 80, spend: 12.4 });
  });
});
