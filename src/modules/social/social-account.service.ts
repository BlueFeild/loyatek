import { AppError, NotFoundError } from "../../core/errors";
import type { SocialStore } from "./social.repository";
import type { MetaAccountConnector } from "./social-types";
import { encryptToken } from "./token-crypto";

// ربط حسابات السوشيال: التاجر يدوس "Connect Facebook & Instagram"، يختار صفحاته في نافذة Meta،
// والكود بيوصل هنا → بنجيب الصفحات + حسابات انستجرام المتربطة ونحفظها (التوكن متشفّر)
export class SocialAccountService {
  constructor(
    private readonly store: SocialStore,
    private readonly meta: MetaAccountConnector
  ) {}

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
    };
  }

  list(tenantId: string) {
    return this.store.listAccounts(tenantId);
  }

  async connectMeta(tenantId: string, userId: string | null, login: { code: string } | { accessToken: string }) {
    const found = await this.meta.discoverAccounts(login);
    if (found.length === 0) {
      throw new AppError(422, "NO_PAGES", "No Facebook Page was shared — press Connect again and tick your Page (and its Instagram account) in the Meta window.");
    }
    await this.store.upsertAccounts(
      tenantId,
      userId,
      found.map((a) => ({ ...a, accessToken: encryptToken(a.accessToken) }))
    );
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

  async disconnect(tenantId: string, id: string) {
    if (!(await this.store.disconnectAccount(tenantId, id))) throw new NotFoundError("Account not found");
    return { ok: true };
  }
}
