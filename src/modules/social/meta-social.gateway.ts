import { graphBase } from "../whatsapp/whatsapp.service";
import {
  SocialPlatformError,
  type DiscoveredAccount,
  type MetaAccountConnector,
  type PublishAccount,
  type PublishContent,
  type PublishResult,
  type SocialPublisher,
} from "./social-types";

// فيسبوك + انستجرام عن طريق Graph API (نفس تطبيق Meta بتاع المنصة).
// META_APP_ID / META_APP_SECRET من Railway، و META_GRAPH_BASE_URL = Meta وهمية للتجارب المحلية بس
const FETCH_TIMEOUT_MS = 60_000;

type GraphJson = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } } & Record<string, any>;

export interface MetaSocialOptions {
  // كل قد إيه نسأل انستجرام "الفيديو جهز؟" وأقصى وقت نستنى
  pollMs?: number;
  maxWaitMs?: number;
}

export class MetaSocialGateway implements MetaAccountConnector, SocialPublisher {
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(opts: MetaSocialOptions = {}) {
    this.pollMs = opts.pollMs ?? 4000;
    this.maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
  }

  private async graph(path: string, opts: { token?: string; method?: "GET" | "POST"; body?: Record<string, unknown> } = {}): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(`${graphBase()}${path}`, {
        method: opts.method ?? "GET",
        headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SocialPlatformError(`Couldn't reach Meta: ${(err as Error).message}`);
    }
    const data = ((await res.json().catch(() => ({}))) ?? {}) as GraphJson;
    if (!res.ok || data.error) {
      const e = data.error ?? {};
      // 190 = التوكن انتهى أو اتلغى (التاجر غيّر الباسورد / شال صلاحية التطبيق)
      const reconnect = e.code === 190 || e.code === 102 || e.error_subcode === 463 || e.error_subcode === 460;
      throw new SocialPlatformError(e.error_user_msg || e.message || `Meta error ${res.status}`, reconnect);
    }
    return data;
  }

  // ---------- الربط ----------
  async discoverAccounts(login: { code: string } | { accessToken: string }): Promise<DiscoveredAccount[]> {
    const appId = process.env.META_APP_ID?.trim();
    const secret = process.env.META_APP_SECRET?.trim();
    let userToken: string;
    if ("code" in login) {
      if (!appId || !secret) throw new SocialPlatformError("Facebook login isn't set up on the server yet.");
      const q = new URLSearchParams({ client_id: appId, client_secret: secret, code: login.code });
      const r = await this.graph(`/oauth/access_token?${q.toString()}`);
      if (typeof r.access_token !== "string") throw new SocialPlatformError("Meta didn't return an access token");
      userToken = r.access_token;
    } else {
      userToken = login.accessToken;
    }

    // توكن طويل (60 يوم) → توكنات الصفحات اللي جاية منه مابتنتهيش
    if (appId && secret) {
      try {
        const q = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: userToken });
        const r = await this.graph(`/oauth/access_token?${q.toString()}`);
        if (typeof r.access_token === "string") userToken = r.access_token;
      } catch (err) {
        console.warn(`[social] long-lived token exchange skipped: ${(err as Error).message}`);
      }
    }

    const fields = "id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}";
    const r = await this.graph(`/me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, { token: userToken });
    const pages: any[] = Array.isArray(r.data) ? r.data : [];
    const out: DiscoveredAccount[] = [];
    for (const p of pages) {
      if (!p?.id || typeof p.access_token !== "string") continue;
      out.push({
        platform: "FACEBOOK",
        externalId: String(p.id),
        name: String(p.name ?? "Facebook Page"),
        username: null,
        pictureUrl: p.picture?.data?.url ?? null,
        parentId: null,
        accessToken: p.access_token,
        tokenExpiresAt: null,
      });
      const ig = p.instagram_business_account;
      if (ig?.id) {
        out.push({
          platform: "INSTAGRAM",
          externalId: String(ig.id),
          name: String(ig.name || ig.username || "Instagram"),
          username: ig.username ?? null,
          pictureUrl: ig.profile_picture_url ?? null,
          parentId: String(p.id),
          // انستجرام بيتنشر بتوكن الصفحة المتربط بيها
          accessToken: p.access_token,
          tokenExpiresAt: null,
        });
      }
    }
    return out;
  }

  // ---------- النشر ----------
  async publish(account: PublishAccount, content: PublishContent): Promise<PublishResult> {
    if (account.platform === "FACEBOOK") return this.publishFacebook(account, content);
    if (account.platform === "INSTAGRAM") return this.publishInstagram(account, content);
    throw new SocialPlatformError(`Publishing to ${account.platform} isn't supported yet`);
  }

  private async publishFacebook(a: PublishAccount, c: PublishContent): Promise<PublishResult> {
    const token = a.accessToken;
    if (!c.media) {
      const r = await this.graph(`/${a.externalId}/feed`, { method: "POST", token, body: { message: c.caption } });
      return { externalPostId: String(r.id), permalink: `https://www.facebook.com/${r.id}` };
    }
    if (c.media.kind === "image") {
      const r = await this.graph(`/${a.externalId}/photos`, { method: "POST", token, body: { url: c.media.url, message: c.caption } });
      const postId = String(r.post_id ?? r.id);
      return { externalPostId: postId, permalink: `https://www.facebook.com/${postId}` };
    }
    const r = await this.graph(`/${a.externalId}/videos`, { method: "POST", token, body: { file_url: c.media.url, description: c.caption } });
    return { externalPostId: String(r.id), permalink: `https://www.facebook.com/${a.externalId}/videos/${r.id}` };
  }

  private async publishInstagram(a: PublishAccount, c: PublishContent): Promise<PublishResult> {
    if (!c.media) throw new SocialPlatformError("Instagram needs a photo or a video.");
    const token = a.accessToken;
    const body: Record<string, unknown> =
      c.media.kind === "image" ? { image_url: c.media.url, caption: c.caption } : { media_type: "REELS", video_url: c.media.url, caption: c.caption, share_to_feed: true };
    const container = await this.graph(`/${a.externalId}/media`, { method: "POST", token, body });
    const containerId = String(container.id);
    await this.waitUntilReady(containerId, token);
    const published = await this.graph(`/${a.externalId}/media_publish`, { method: "POST", token, body: { creation_id: containerId } });
    const mediaId = String(published.id);
    let permalink: string | null = null;
    try {
      const m = await this.graph(`/${mediaId}?fields=permalink`, { token });
      permalink = typeof m.permalink === "string" ? m.permalink : null;
    } catch {
      // البوست نزل خلاص - اللينك مش ضروري
    }
    return { externalPostId: mediaId, permalink };
  }

  // انستجرام بيجهّز الملف الأول (الفيديو ممكن ياخد دقيقة أو اتنين)
  private async waitUntilReady(containerId: string, token: string) {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const s = await this.graph(`/${containerId}?fields=status_code,status`, { token });
      if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED" || s.status_code === undefined) return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        throw new SocialPlatformError(`Instagram couldn't process the file${s.status ? ` (${s.status})` : ""}. Check the size and format and try again.`);
      }
      if (Date.now() >= deadline) throw new SocialPlatformError("Instagram took too long to process the file — try again.");
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}
