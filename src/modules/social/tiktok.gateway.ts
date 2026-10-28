import {
  SocialPlatformError,
  type DiscoveredAccount,
  type PublishAccount,
  type PublishContent,
  type PublishResult,
  type RefreshedTokens,
  type SocialPublisher,
  type TikTokConnector,
  type TikTokCreatorInfo,
} from "./social-types";

// تيك توك: Login Kit (ربط الحساب) + Content Posting API (النشر المباشر).
// TIKTOK_CLIENT_KEY (عام) و TIKTOK_CLIENT_SECRET (سر - Railway بس).
// TIKTOK_API_BASE_URL / TIKTOK_AUTH_URL = تيك توك وهمي للتجارب المحلية بس
const SCOPES = "user.info.basic,video.publish,video.upload";
const FETCH_TIMEOUT_MS = 60_000;
// تيك توك: لحد 64MB يترفع مرة واحدة، أكبر من كده أجزاء (كل جزء 5-64MB والأخير ياخد الباقي)
const SINGLE_UPLOAD_MAX = 64 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

// أخطاء معناها إن التاجر لازم يربط تاني
const RECONNECT = new Set(["access_token_invalid", "scope_not_authorized", "scope_permission_missed", "invalid_grant"]);
// رسايل أوضح لأشهر الأخطاء
const FRIENDLY: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts: "Until TikTok approves our app, posts can only be published as “Only me” (private).",
  spam_risk_too_many_posts: "TikTok says this account posted too many times today — try again tomorrow.",
  spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting.",
  privacy_level_option_mismatch: "That “who can see it” option isn't available for this TikTok account — pick another.",
  url_ownership_unverified: "TikTok needs our media domain verified before photo posts work — videos work meanwhile.",
};

export interface TikTokOptionsConfig {
  pollMs?: number;
  maxWaitMs?: number;
}

function apiBase() {
  return (process.env.TIKTOK_API_BASE_URL || "https://open.tiktokapis.com").replace(/\/+$/, "");
}

export class TikTokGateway implements TikTokConnector, SocialPublisher {
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(opts: TikTokOptionsConfig = {}) {
    this.pollMs = opts.pollMs ?? 5000;
    this.maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
  }

  get enabled() {
    return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() && process.env.TIKTOK_CLIENT_SECRET?.trim());
  }

  private keys() {
    const key = process.env.TIKTOK_CLIENT_KEY?.trim();
    const secret = process.env.TIKTOK_CLIENT_SECRET?.trim();
    if (!key || !secret) throw new SocialPlatformError("TikTok isn't set up on the server yet.");
    return { key, secret };
  }

  authorizeUrl(state: string, redirectUri: string) {
    const base = process.env.TIKTOK_AUTH_URL || "https://www.tiktok.com/v2/auth/authorize/";
    const q = new URLSearchParams({ client_key: this.keys().key, scope: SCOPES, response_type: "code", redirect_uri: redirectUri, state });
    return `${base}?${q.toString()}`;
  }

  // ---------- طلبات ----------
  private async token(params: Record<string, string>) {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/v2/oauth/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SocialPlatformError(`Couldn't reach TikTok: ${(err as Error).message}`);
    }
    const d = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || d.error || typeof d.access_token !== "string") {
      const code = typeof d.error === "string" ? d.error : "";
      throw new SocialPlatformError(`TikTok: ${d.error_description || code || `error ${res.status}`}`, RECONNECT.has(code));
    }
    const now = Date.now();
    return {
      accessToken: d.access_token as string,
      tokenExpiresAt: new Date(now + Number(d.expires_in ?? 86400) * 1000),
      refreshToken: String(d.refresh_token ?? ""),
      refreshExpiresAt: d.refresh_expires_in ? new Date(now + Number(d.refresh_expires_in) * 1000) : null,
      openId: String(d.open_id ?? ""),
    };
  }

  private async api(path: string, token: string, body?: unknown, method: "GET" | "POST" = body === undefined ? "GET" : "POST"): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SocialPlatformError(`Couldn't reach TikTok: ${(err as Error).message}`);
    }
    const d = (await res.json().catch(() => ({}))) as Record<string, any>;
    const code = d.error?.code;
    if (!res.ok || (code && code !== "ok")) {
      throw new SocialPlatformError(FRIENDLY[code] ?? `TikTok: ${d.error?.message || code || `error ${res.status}`}`, RECONNECT.has(code));
    }
    return d.data ?? {};
  }

  // ---------- الربط ----------
  async exchangeCode(code: string, redirectUri: string): Promise<DiscoveredAccount> {
    const { key, secret } = this.keys();
    const t = await this.token({ client_key: key, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: redirectUri });
    const info = await this.api("/v2/user/info/?fields=open_id,avatar_url,display_name,username", t.accessToken);
    const u = info.user ?? {};
    return {
      platform: "TIKTOK",
      externalId: String(u.open_id || t.openId),
      name: String(u.display_name || u.username || "TikTok"),
      username: u.username ?? null,
      pictureUrl: u.avatar_url ?? null,
      parentId: null,
      accessToken: t.accessToken,
      tokenExpiresAt: t.tokenExpiresAt,
      refreshToken: t.refreshToken,
      refreshExpiresAt: t.refreshExpiresAt,
    };
  }

  async refresh(refreshToken: string): Promise<RefreshedTokens> {
    const { key, secret } = this.keys();
    const t = await this.token({ client_key: key, client_secret: secret, grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: t.accessToken, tokenExpiresAt: t.tokenExpiresAt, refreshToken: t.refreshToken || refreshToken, refreshExpiresAt: t.refreshExpiresAt };
  }

  async creatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const d = await this.api("/v2/post/publish/creator_info/query/", accessToken, {});
    return {
      nickname: String(d.creator_nickname ?? ""),
      username: String(d.creator_username ?? ""),
      avatarUrl: d.creator_avatar_url ?? null,
      privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options.map(String) : [],
      commentDisabled: Boolean(d.comment_disabled),
      duetDisabled: Boolean(d.duet_disabled),
      stitchDisabled: Boolean(d.stitch_disabled),
      maxVideoDurationSec: Number(d.max_video_post_duration_sec ?? 600),
    };
  }

  // ---------- النشر ----------
  async publish(account: PublishAccount, content: PublishContent): Promise<PublishResult> {
    const o = content.options?.tiktok;
    if (!o?.privacyLevel) throw new SocialPlatformError("Choose who can see the TikTok post.");
    if (!content.media) throw new SocialPlatformError("TikTok needs a video or a photo.");
    const token = account.accessToken;
    const postInfo = {
      privacy_level: o.privacyLevel,
      disable_comment: !o.allowComment,
      brand_organic_toggle: o.brandOrganic,
      brand_content_toggle: o.brandedContent,
    };

    let publishId: string;
    if (content.media.kind === "video") {
      if (!content.media.load) throw new SocialPlatformError("The video file couldn't be read.");
      const bytes = await content.media.load();
      const size = bytes.length;
      const chunkSize = size <= SINGLE_UPLOAD_MAX ? size : CHUNK;
      const count = size <= SINGLE_UPLOAD_MAX ? 1 : Math.floor(size / CHUNK);
      const init = await this.api("/v2/post/publish/video/init/", token, {
        post_info: { ...postInfo, title: content.caption.slice(0, 2200), disable_duet: !o.allowDuet, disable_stitch: !o.allowStitch },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
      });
      publishId = String(init.publish_id);
      await this.upload(String(init.upload_url), bytes, chunkSize, count, content.media.mimeType || "video/mp4");
    } else {
      const init = await this.api("/v2/post/publish/content/init/", token, {
        post_info: { ...postInfo, title: content.caption.slice(0, 90), description: content.caption.slice(0, 4000), auto_add_music: true },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [content.media.url] },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      });
      publishId = String(init.publish_id);
    }

    const postId = await this.waitUntilPublished(publishId, token);
    const kind = content.media.kind === "video" ? "video" : "photo";
    return { externalPostId: postId ?? publishId, permalink: postId && account.username ? `https://www.tiktok.com/@${account.username}/${kind}/${postId}` : null };
  }

  private async upload(url: string, bytes: Buffer, chunkSize: number, count: number, mimeType: string) {
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? bytes.length - 1 : start + chunkSize - 1;
      const part = bytes.subarray(start, end + 1);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": mimeType, "Content-Length": String(part.length), "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
          body: part,
          signal: AbortSignal.timeout(5 * 60 * 1000),
        });
      } catch (err) {
        throw new SocialPlatformError(`Uploading the video to TikTok failed: ${(err as Error).message}`);
      }
      if (!res.ok) throw new SocialPlatformError(`Uploading the video to TikTok failed (${res.status}).`);
    }
  }

  // تيك توك بيعالج البوست بعد الرفع - بنستنى لحد ما ينزل أو يفشل
  private async waitUntilPublished(publishId: string, token: string): Promise<string | null> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const s = await this.api("/v2/post/publish/status/fetch/", token, { publish_id: publishId });
      if (s.status === "PUBLISH_COMPLETE") {
        const ids = s.publicaly_available_post_id ?? s.publicly_available_post_id;
        return Array.isArray(ids) && ids.length ? String(ids[0]) : null;
      }
      if (s.status === "FAILED") throw new SocialPlatformError(FRIENDLY[s.fail_reason] ?? `TikTok couldn't publish it (${s.fail_reason ?? "unknown reason"}).`);
      // لو اتبعت لصندوق التاجر في التطبيق (مش نشر مباشر) نعتبره خلص
      if (s.status === "SEND_TO_USER_INBOX") return null;
      if (Date.now() >= deadline) throw new SocialPlatformError("TikTok is still processing the post — check the TikTok app in a few minutes.");
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}
