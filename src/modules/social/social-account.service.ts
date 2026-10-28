import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import type { SocialStore } from "./social.repository";
import type { DiscoveredAccount, MetaAccountConnector, TikTokConnector } from "./social-types";
import { SocialTokenService } from "./social-token.service";
import { decryptToken, encryptToken } from "./token-crypto";

// لينك ربط تيك توك صالح 15 دقيقة
const TIKTOK_STATE_TTL_MS = 15 * 60 * 1000;

export interface SocialAccountOptions {
  tiktok?: TikTokConnector;
  tokens?: SocialTokenService;
  // عنوان الباك إند العام (تيك توك بيرجع على /api/public/social/tiktok/callback)
  publicApiBaseUrl?: () => string;
  // عنوان الموقع (بعد ربط تيك توك نرجّع التاجر لصفحة النشر)
  frontendBaseUrl?: () => string;
  now?: () => Date;
}

// ربط حسابات السوشيال: التاجر يدوس "Connect Facebook & Instagram"، يختار صفحاته في نافذة Meta،
// والكود بيوصل هنا → بنجيب الصفحات + حسابات انستجرام المتربطة ونحفظها (التوكن متشفّر).
// تيك توك: لينك دخول تيك توك → بيرجع على الـ callback بكود → بنحفظ الحساب
export class SocialAccountService {
  private readonly tiktok?: TikTokConnector;
  private readonly tokens: SocialTokenService;
  private readonly now: () => Date;

  constructor(
    private readonly store: SocialStore,
    private readonly meta: MetaAccountConnector,
    private readonly opts: SocialAccountOptions = {}
  ) {
    this.tiktok = opts.tiktok;
    this.tokens = opts.tokens ?? new SocialTokenService(store);
    this.now = opts.now ?? (() => new Date());
  }

  // الإعدادات العامة لزرار الربط (مفيش أسرار هنا)
  config() {
    const appId = process.env.META_APP_ID?.trim() || null;
    const configId = process.env.META_SOCIAL_CONFIG_ID?.trim() || null;
    const hasSecret = Boolean(process.env.META_APP_SECRET?.trim());
    return {
      meta: {
        enabled: Boolean(appId && configId && hasSecret),
        appId,
        configId,
        graphVersion: (process.env.META_GRAPH_VERSION || "v26.0").trim(),
      },
      tiktok: { enabled: Boolean(this.tiktok?.enabled) },
    };
  }

  list(tenantId: string) {
    return this.store.listAccounts(tenantId);
  }

  private save(tenantId: string, userId: string | null, found: DiscoveredAccount[]) {
    return this.store.upsertAccounts(
      tenantId,
      userId,
      found.map((a) => ({ ...a, accessToken: encryptToken(a.accessToken), refreshToken: a.refreshToken ? encryptToken(a.refreshToken) : null }))
    );
  }

  async connectMeta(tenantId: string, userId: string | null, login: { code: string } | { accessToken: string }) {
    const found = await this.meta.discoverAccounts(login);
    if (found.length === 0) {
      throw new AppError(422, "NO_PAGES", "No Facebook Page was shared — press Connect again and tick your Page (and its Instagram account) in the Meta window.");
    }
    await this.save(tenantId, userId, found);
    // التعليقات والرسايل الجديدة توصل لوحدها (لو فشل، زرار "Check for new" بيجيبها)
    if (this.meta.subscribePage) {
      for (const p of found.filter((a) => a.platform === "FACEBOOK")) {
        await this.meta.subscribePage(p.externalId, p.accessToken).catch((err) => console.warn(`[social] subscribing page ${p.externalId} to webhooks failed: ${(err as Error).message}`));
      }
    }
    const accounts = await this.store.listAccounts(tenantId);
    const hasInstagram = found.some((a) => a.platform === "INSTAGRAM");
    return {
      accounts,
      connected: found.length,
      // الصفحة متربطة بس من غير انستجرام بيزنس → نقول للتاجر يربطه من إعدادات الصفحة
      warning: hasInstagram ? null : "No Instagram business account is linked to these Pages. Link it in Instagram (Settings → Account type → Business) and connect again.",
    };
  }

  // ---------- تيك توك ----------
  private tiktokRedirectUri() {
    const configured = process.env.TIKTOK_REDIRECT_URI?.trim();
    if (configured) return configured;
    return `${(this.opts.publicApiBaseUrl ?? (() => "http://localhost:4000"))()}/api/public/social/tiktok/callback`;
  }

  private requireTikTok(): TikTokConnector {
    if (!this.tiktok?.enabled) throw new AppError(503, "TIKTOK_NOT_SET_UP", "Connecting TikTok isn't switched on yet — please contact BlueField support.");
    return this.tiktok;
  }

  // لينك دخول تيك توك. الـ state متشفّر (مين الشركة + صلاحيته) - محدش يقدر يربط حسابه بشركة غيره
  tiktokConnectUrl(tenantId: string, userId: string | null) {
    const tiktok = this.requireTikTok();
    const state = Buffer.from(encryptToken(JSON.stringify({ t: tenantId, u: userId, e: this.now().getTime() + TIKTOK_STATE_TTL_MS }))).toString("base64url");
    return { url: tiktok.authorizeUrl(state, this.tiktokRedirectUri()) };
  }

  // تيك توك رجّع التاجر بكود → نحفظ الحساب ونرجّعه لصفحة النشر (بنتيجة الربط في اللينك)
  async tiktokCallback(query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<string> {
    const back = (params: Record<string, string>) => `${(this.opts.frontendBaseUrl ?? (() => ""))()}/ai-studio?${new URLSearchParams({ tool: "publish", ...params }).toString()}`;
    let state: { t: string; u: string | null; e: number };
    try {
      state = JSON.parse(decryptToken(Buffer.from(String(query.state ?? ""), "base64url").toString("utf8")));
    } catch {
      return back({ tiktok_error: "This TikTok link isn't valid — press Connect TikTok again." });
    }
    if (!state?.t || state.e < this.now().getTime()) return back({ tiktok_error: "The TikTok link expired — press Connect TikTok again." });
    if (query.error || !query.code) return back({ tiktok_error: query.error === "access_denied" ? "TikTok connection was cancelled." : `TikTok: ${query.error_description || query.error || "no code returned"}` });
    try {
      const account = await this.requireTikTok().exchangeCode(query.code, this.tiktokRedirectUri());
      await this.save(state.t, state.u, [account]);
      return back({ tiktok: "connected" });
    } catch (err) {
      return back({ tiktok_error: err instanceof Error ? err.message : "Connecting TikTok failed" });
    }
  }

  // بيانات الحساب اللي تيك توك بيطلب نعرضها قبل النشر (مين يقدر يشوف، التعليقات...)
  async tiktokCreatorInfo(tenantId: string, accountId: string) {
    const tiktok = this.requireTikTok();
    const a = await this.store.accountForPublish(accountId);
    if (!a || a.tenantId !== tenantId || a.platform !== "TIKTOK") throw new NotFoundError("TikTok account not found");
    if (a.status !== "ACTIVE") throw new ValidationError("This TikTok account needs to be connected again.");
    try {
      return await tiktok.creatorInfo(await this.tokens.accessToken(a));
    } catch (err) {
      if (err instanceof AppError && (err as { needsReconnect?: boolean }).needsReconnect) await this.store.markAccount(a.id, "NEEDS_RECONNECT", err.message);
      throw err;
    }
  }

  async disconnect(tenantId: string, id: string) {
    if (!(await this.store.disconnectAccount(tenantId, id))) throw new NotFoundError("Account not found");
    return { ok: true };
  }
}
