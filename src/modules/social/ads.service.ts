import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { isCurrencyCode, rateFor, type Rates } from "../../utils/money";
import { AD_LIMITS, statusFromMeta, toMinorUnits, type AdObjective, type AdsPlatform, type AdTargeting } from "./ads-types";
import type { AdCampaignRow, AdsStore } from "./ads.repository";
import { SocialPlatformError } from "./social-types";
import { decryptToken, encryptToken } from "./token-crypto";

// حدود الإعلانات من السوبر أدمن (platform_settings)
export interface AdsLimits {
  maxDailyBudgetUsd: number;
  maxDays: number;
}

export interface AdsServiceOptions {
  limits: () => Promise<AdsLimits>;
  rates: () => Promise<Rates>;
  now?: () => Date;
}

export interface BoostInput {
  targetId: string;
  adAccountId: string;
  objective: AdObjective;
  dailyBudget: number;
  days: number;
  startAt?: Date;
  targeting: AdTargeting;
  // المبلغ اللي التاجر شافه ووافق عليه (الميزانية × الأيام) - لازم يطابق حسابنا
  confirmedTotal: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PAUSABLE = ["ACTIVE", "PENDING_REVIEW", "ISSUE"];
const FINAL = ["FAILED", "CREATING"];

const round2 = (n: number) => Math.round(n * 100) / 100;

// "تمويل بوست" على فيسبوك / انستجرام. الفلوس بتتدفع من حساب إعلانات التاجر نفسه (مش من عندنا)،
// وإحنا بنحمي التاجر: حد أقصى للميزانية والمدة، تأكيد المبلغ قبل الصرف، وسجل لكل حركة
export class SocialAdsService {
  private readonly now: () => Date;

  constructor(
    private readonly store: AdsStore,
    private readonly platform: AdsPlatform,
    private readonly opts: AdsServiceOptions
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // بيتنده وقت "Connect Facebook & Instagram" - توكن المستخدم الطويل (متشفّر)
  async saveConnection(tenantId: string, userId: string | null, userToken: string, expiresAt: Date | null) {
    await this.store.saveAuth(tenantId, { accessToken: encryptToken(userToken), tokenExpiresAt: expiresAt, connectedById: userId });
  }

  private reconnectError(message = "Your Facebook connection for ads has expired — press “Connect Facebook & Instagram” again.") {
    return new AppError(409, "ADS_RECONNECT", message);
  }

  private async userToken(tenantId: string): Promise<string> {
    const auth = await this.store.getAuth(tenantId);
    if (!auth) throw this.reconnectError("Connect Facebook & Instagram again (and allow ads) to run ads from here.");
    if (auth.tokenExpiresAt && auth.tokenExpiresAt <= this.now()) throw this.reconnectError();
    try {
      return decryptToken(auth.accessToken);
    } catch {
      throw this.reconnectError();
    }
  }

  // أخطاء Meta بكلام التاجر: التوكن انتهى / الصلاحية ناقصة / الباقي زي ما هو
  private friendly(err: unknown): unknown {
    if (!(err instanceof SocialPlatformError)) return err;
    if (err.needsReconnect) return this.reconnectError();
    if (err.platformCode === 200 || err.platformCode === 10 || err.platformCode === 294) {
      return this.reconnectError("Meta didn't allow ads for this connection yet — press “Connect Facebook & Instagram” again and allow ads (manage ads) in the Meta window.");
    }
    return err;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.friendly(err);
    }
  }

  // الحد الأقصى/الأدنى للميزانية اليومية بعملة حساب الإعلانات
  private async budgetRange(currency: string) {
    if (currency !== "USD" && !isCurrencyCode(currency)) {
      throw new ValidationError(`Ad accounts in ${currency} aren't supported yet — use an ad account in USD, QAR or another Gulf currency.`);
    }
    const [limits, rates] = await Promise.all([this.opts.limits(), this.opts.rates()]);
    const rate = rateFor(currency, rates);
    return {
      min: Math.ceil(AD_LIMITS.minDailyUsd * rate * 100) / 100,
      max: Math.floor(limits.maxDailyBudgetUsd * rate * 100) / 100,
      maxDays: limits.maxDays,
    };
  }

  async overview(tenantId: string) {
    const [auth, limits] = await Promise.all([this.store.getAuth(tenantId), this.opts.limits()]);
    const expired = Boolean(auth?.tokenExpiresAt && auth.tokenExpiresAt <= this.now());
    return { connected: Boolean(auth) && !expired, expired, limits: { maxDailyBudgetUsd: limits.maxDailyBudgetUsd, maxDays: limits.maxDays, minDailyUsd: AD_LIMITS.minDailyUsd } };
  }

  async adAccounts(tenantId: string) {
    const token = await this.userToken(tenantId);
    const accounts = await this.call(() => this.platform.listAdAccounts(token));
    const out = [];
    for (const a of accounts) {
      const supported = a.currency === "USD" || isCurrencyCode(a.currency);
      const range = supported ? await this.budgetRange(a.currency) : null;
      out.push({ ...a, supported, minDaily: range?.min ?? null, maxDaily: range?.max ?? null, maxDays: range?.maxDays ?? null });
    }
    return out;
  }

  async searchCities(tenantId: string, query: string) {
    const token = await this.userToken(tenantId);
    return this.call(() => this.platform.searchCities(token, query));
  }

  async boost(tenantId: string, userId: string | null, input: BoostInput) {
    const now = this.now();
    const target = await this.store.boostTarget(tenantId, input.targetId);
    if (!target) throw new NotFoundError("Post not found");
    if (target.platform !== "FACEBOOK" && target.platform !== "INSTAGRAM") throw new ValidationError("Only Facebook and Instagram posts can be boosted for now.");
    if (target.status !== "PUBLISHED" || !target.externalPostId) throw new ValidationError("Only a published post can be boosted.");
    if (target.accountStatus !== "ACTIVE") throw new ValidationError("This page needs to be connected again before you can boost its posts.");
    const pageId = target.platform === "INSTAGRAM" ? target.accountParentId : target.accountExternalId;
    if (!pageId) throw new ValidationError("This Instagram account isn't linked to a Facebook Page — connect it again.");

    // المدة والميعاد
    const days = input.days;
    const startAt = input.startAt && input.startAt > now ? input.startAt : now;
    if (startAt.getTime() - now.getTime() > 30 * DAY_MS) throw new ValidationError("The ad can start at most 30 days from today.");
    const endAt = new Date(startAt.getTime() + days * DAY_MS);

    const token = await this.userToken(tenantId);
    const adAccount = (await this.call(() => this.platform.listAdAccounts(token))).find((a) => a.id === input.adAccountId);
    if (!adAccount) throw new ValidationError("That ad account isn't available on your Meta connection.");
    if (!adAccount.active) throw new ValidationError(`This ad account can't run ads right now (${adAccount.statusText}).`);

    // حماية الفلوس: الحد الأدنى والأقصى + المدة + المبلغ اللي اتأكد
    const range = await this.budgetRange(adAccount.currency);
    if (days < 1 || days > range.maxDays) throw new ValidationError(`An ad can run between 1 and ${range.maxDays} days.`);
    const daily = round2(input.dailyBudget);
    if (daily < range.min) throw new ValidationError(`The daily budget must be at least ${range.min} ${adAccount.currency}.`);
    if (daily > range.max) throw new ValidationError(`The daily budget can't be more than ${range.max} ${adAccount.currency} (platform limit).`);
    const total = round2(daily * days);
    if (Math.abs(round2(input.confirmedTotal) - total) > 0.005) {
      throw new ValidationError(`Please confirm the total again: ${total} ${adAccount.currency} (${daily} × ${days} days).`);
    }
    if (await this.store.creatingSince(tenantId, target.externalPostId, new Date(now.getTime() - AD_LIMITS.duplicateWindowMs))) {
      throw new AppError(409, "BOOST_IN_PROGRESS", "This post is already being boosted — wait a moment and refresh.");
    }

    const id = await this.store.createCampaign({
      tenantId,
      accountId: target.accountId,
      platform: target.platform,
      postExternalId: target.externalPostId,
      permalink: target.permalink,
      caption: target.caption ? target.caption.slice(0, 500) : null,
      adAccountId: adAccount.id,
      adAccountName: adAccount.name,
      currency: adAccount.currency,
      objective: input.objective,
      dailyBudget: daily,
      startAt,
      endAt,
      targeting: input.targeting,
      createdById: userId,
    });
    const details = { dailyBudget: daily, days, total, currency: adAccount.currency, objective: input.objective, adAccountId: adAccount.id };
    try {
      const ids = await this.call(() =>
        this.platform.createBoost(token, {
          adAccountId: adAccount.id,
          name: `BlueField boost · ${target.accountName} · ${now.toISOString().slice(0, 10)}`,
          objective: input.objective,
          platform: target.platform as "FACEBOOK" | "INSTAGRAM",
          pageId,
          instagramUserId: target.platform === "INSTAGRAM" ? target.accountExternalId : null,
          postExternalId: target.externalPostId!,
          caption: target.caption || null,
          dailyBudgetMinor: toMinorUnits(daily),
          startAt,
          endAt,
          targeting: input.targeting,
        })
      );
      await this.store.updateCampaign(id, {
        status: "PENDING_REVIEW",
        metaStatus: "PENDING_REVIEW",
        metaCampaignId: ids.campaignId,
        metaAdSetId: ids.adSetId,
        metaCreativeId: ids.creativeId,
        metaAdId: ids.adId,
        syncedAt: now,
      });
      await this.store.addEvent({ tenantId, campaignId: id, userId, action: "CREATED", details });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Meta refused the ad";
      await this.store.updateCampaign(id, { status: "FAILED", error: message });
      await this.store.addEvent({ tenantId, campaignId: id, userId, action: "FAILED", details: { ...details, error: message } });
      throw err;
    }
    return this.view((await this.store.getCampaign(tenantId, id))!);
  }

  // الأرقام والحالة من Meta (لو أقدم من 10 دقايق، أو force)
  private async refresh(c: AdCampaignRow, token: string | null, force: boolean): Promise<AdCampaignRow> {
    if (!token || !c.metaAdId || !c.metaCampaignId || FINAL.includes(c.status)) return c;
    const now = this.now();
    // إعلان خلص: نجيب أرقامه النهائية مرة بعد ما يخلص بيوم وخلاص
    if (c.status === "COMPLETED" && c.syncedAt && c.syncedAt.getTime() > c.endAt.getTime() + DAY_MS) return c;
    if (!force && c.syncedAt && now.getTime() - c.syncedAt.getTime() < AD_LIMITS.refreshAfterMs) return c;
    try {
      const [state, insights] = await Promise.all([this.platform.getState(token, c.metaAdId), this.platform.getInsights(token, c.metaCampaignId)]);
      const patch = { status: statusFromMeta(state.metaStatus, c.endAt, now), metaStatus: state.metaStatus, reviewFeedback: state.reviewFeedback, ...insights, syncedAt: now };
      await this.store.updateCampaign(c.id, patch);
      return { ...c, ...patch };
    } catch (err) {
      console.warn(`[social-ads] refreshing ${c.id} failed: ${(err as Error).message}`);
      return c;
    }
  }

  private async tokenOrNull(tenantId: string) {
    try {
      return await this.userToken(tenantId);
    } catch {
      return null;
    }
  }

  private view(c: AdCampaignRow) {
    const days = Math.max(1, Math.round((c.endAt.getTime() - c.startAt.getTime()) / DAY_MS));
    const { tenantId: _t, metaAdSetId: _s, ...rest } = c;
    return { ...rest, days, maxTotal: round2(c.dailyBudget * days) };
  }

  async list(tenantId: string) {
    const rows = await this.store.listCampaigns(tenantId);
    const token = rows.some((r) => !FINAL.includes(r.status)) ? await this.tokenOrNull(tenantId) : null;
    // أول 10 بس بيتحدّثوا في الطلب الواحد (الباقي في المرة الجاية)
    const fresh = await Promise.all(rows.map((r, i) => (i < 10 ? this.refresh(r, token, false) : r)));
    return { campaigns: fresh.map((r) => this.view(r)), overview: await this.overview(tenantId) };
  }

  async get(tenantId: string, id: string) {
    const c = await this.store.getCampaign(tenantId, id);
    if (!c) throw new NotFoundError("Ad not found");
    const fresh = await this.refresh(c, await this.tokenOrNull(tenantId), true);
    return { ...this.view(fresh), events: await this.store.events(tenantId, id) };
  }

  private async mustGet(tenantId: string, id: string) {
    const c = await this.store.getCampaign(tenantId, id);
    if (!c) throw new NotFoundError("Ad not found");
    if (!c.metaCampaignId || !c.metaAdSetId) throw new ValidationError("This ad was never created at Meta.");
    return c;
  }

  async pause(tenantId: string, userId: string | null, id: string) {
    const c = await this.mustGet(tenantId, id);
    if (!PAUSABLE.includes(c.status)) throw new ValidationError("Only a running ad can be paused.");
    const token = await this.userToken(tenantId);
    await this.call(() => this.platform.setStatus(token, c.metaCampaignId!, "PAUSED"));
    await this.store.updateCampaign(id, { status: "PAUSED", metaStatus: "CAMPAIGN_PAUSED" });
    await this.store.addEvent({ tenantId, campaignId: id, userId, action: "PAUSED" });
    return this.get(tenantId, id);
  }

  async resume(tenantId: string, userId: string | null, id: string) {
    const c = await this.mustGet(tenantId, id);
    if (c.status !== "PAUSED") throw new ValidationError("Only a paused ad can be started again.");
    if (c.endAt <= this.now()) throw new ValidationError("This ad's end date has passed — boost the post again instead.");
    const token = await this.userToken(tenantId);
    await this.call(() => this.platform.setStatus(token, c.metaCampaignId!, "ACTIVE"));
    await this.store.updateCampaign(id, { status: "ACTIVE", metaStatus: "ACTIVE" });
    await this.store.addEvent({ tenantId, campaignId: id, userId, action: "RESUMED" });
    return this.get(tenantId, id);
  }

  async changeBudget(tenantId: string, userId: string | null, id: string, dailyBudget: number) {
    const c = await this.mustGet(tenantId, id);
    if (!PAUSABLE.includes(c.status) && c.status !== "PAUSED") throw new ValidationError("This ad has finished — its budget can't change.");
    const range = await this.budgetRange(c.currency);
    const daily = round2(dailyBudget);
    if (daily < range.min) throw new ValidationError(`The daily budget must be at least ${range.min} ${c.currency}.`);
    if (daily > range.max) throw new ValidationError(`The daily budget can't be more than ${range.max} ${c.currency} (platform limit).`);
    const token = await this.userToken(tenantId);
    await this.call(() => this.platform.setDailyBudget(token, c.metaAdSetId!, toMinorUnits(daily)));
    await this.store.updateCampaign(id, { dailyBudget: daily });
    await this.store.addEvent({ tenantId, campaignId: id, userId, action: "BUDGET_CHANGED", details: { from: c.dailyBudget, to: daily, currency: c.currency } });
    return this.get(tenantId, id);
  }
}
