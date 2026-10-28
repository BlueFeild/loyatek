import { graphBase } from "../whatsapp/whatsapp.service";
import {
  SocialPlatformError,
  type DiscoveredAccount,
  type InboxAccount,
  type InboxEvent,
  type MetaAccountConnector,
  type PublishAccount,
  type PublishContent,
  type PublishResult,
  type RecentInbox,
  type SocialInboxGateway,
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

export class MetaSocialGateway implements MetaAccountConnector, SocialPublisher, SocialInboxGateway {
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

  // ---------- صندوق التعليقات والرسايل ----------

  // الصفحة لازم "تشترك" في تطبيقنا عشان Meta تبعت تعليقاتها ورسايلها على الـ webhook
  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.graph(`/${pageId}/subscribed_apps`, { method: "POST", token: pageToken, body: { subscribed_fields: "feed,messages" } });
  }

  async replyToComment(a: InboxAccount, commentId: string, text: string) {
    // فيسبوك: تعليق على التعليق. انستجرام: endpoint اسمه replies
    const path = a.platform === "INSTAGRAM" ? `/${commentId}/replies` : `/${commentId}/comments`;
    const r = await this.graph(path, { method: "POST", token: a.accessToken, body: { message: text } });
    return { id: String(r.id) };
  }

  async sendDirectMessage(a: InboxAccount, recipientId: string, text: string) {
    // رسايل انستجرام بتتبعت عن طريق صفحة فيسبوك المربوطة بيه
    const pageId = a.platform === "INSTAGRAM" ? a.parentId : a.externalId;
    if (!pageId) throw new SocialPlatformError("This Instagram account isn't linked to a Facebook Page — connect it again.");
    const r = await this.graph(`/${pageId}/messages`, {
      method: "POST",
      token: a.accessToken,
      body: { recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text } },
    });
    return { id: String(r.message_id ?? r.id) };
  }

  async lookupName(a: InboxAccount, userId: string): Promise<string | null> {
    const fields = a.platform === "INSTAGRAM" ? "name,username" : "name";
    const r = await this.graph(`/${encodeURIComponent(userId)}?fields=${fields}`, { token: a.accessToken });
    const name = (a.platform === "INSTAGRAM" ? r.username ?? r.name : r.name) as unknown;
    return typeof name === "string" && name ? name : null;
  }

  async fetchRecent(a: InboxAccount): Promise<RecentInbox> {
    if (a.platform !== "FACEBOOK" && a.platform !== "INSTAGRAM") return { events: [], warnings: [] };
    const parts = a.platform === "FACEBOOK" ? [this.fbComments(a), this.conversations(a, a.externalId, "messenger")] : [this.igComments(a), this.conversations(a, a.parentId, "instagram")];
    const results = await Promise.allSettled(parts);
    const ok = results.filter((r): r is PromiseFulfilledResult<InboxEvent[]> => r.status === "fulfilled");
    // جزء فشل (صلاحية الرسايل لسه مش متاحة مثلًا) مايوقفش الباقي
    if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
    const warnings = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason instanceof Error ? r.reason.message : "failed"));
    return { events: ok.flatMap((r) => r.value), warnings };
  }

  private async fbComments(a: InboxAccount): Promise<InboxEvent[]> {
    const posts = await this.graph(`/${a.externalId}/posts?fields=id,message&limit=10`, { token: a.accessToken });
    const out: InboxEvent[] = [];
    for (const p of Array.isArray(posts.data) ? posts.data : []) {
      const fields = encodeURIComponent("id,message,from{id,name},created_time,parent{id}");
      const r = await this.graph(`/${p.id}/comments?fields=${fields}&filter=stream&limit=50`, { token: a.accessToken });
      for (const c of Array.isArray(r.data) ? r.data : []) {
        if (!c?.id || !c.message) continue;
        const parent = c.parent?.id ? String(c.parent.id) : null;
        out.push({
          platform: "FACEBOOK",
          accountExternalId: a.externalId,
          kind: "COMMENT",
          direction: c.from?.id === a.externalId ? "OUT" : "IN",
          externalId: String(c.id),
          threadKey: parent ?? String(c.id),
          parentExternalId: parent,
          postExternalId: String(p.id),
          postCaption: typeof p.message === "string" ? p.message.slice(0, 500) : null,
          authorId: c.from?.id ?? null,
          authorName: c.from?.name ?? null,
          text: String(c.message),
          createdAt: new Date(c.created_time ?? Date.now()),
        });
      }
    }
    return out;
  }

  private async igComments(a: InboxAccount): Promise<InboxEvent[]> {
    const media = await this.graph(`/${a.externalId}/media?fields=id,caption&limit=10`, { token: a.accessToken });
    const out: InboxEvent[] = [];
    const one = (c: any, mediaId: string, caption: string | null, parent: string | null): InboxEvent => ({
      platform: "INSTAGRAM",
      accountExternalId: a.externalId,
      kind: "COMMENT",
      direction: c.from?.id === a.externalId ? "OUT" : "IN",
      externalId: String(c.id),
      threadKey: parent ?? String(c.id),
      parentExternalId: parent,
      postExternalId: mediaId,
      postCaption: caption,
      authorId: c.from?.id ?? null,
      authorName: c.username ?? c.from?.username ?? null,
      text: String(c.text),
      createdAt: new Date(c.timestamp ?? Date.now()),
    });
    for (const m of Array.isArray(media.data) ? media.data : []) {
      const caption = typeof m.caption === "string" ? m.caption.slice(0, 500) : null;
      const fields = encodeURIComponent("id,text,username,from{id,username},timestamp,replies{id,text,username,from{id,username},timestamp}");
      const r = await this.graph(`/${m.id}/comments?fields=${fields}&limit=50`, { token: a.accessToken });
      for (const c of Array.isArray(r.data) ? r.data : []) {
        if (!c?.id || !c.text) continue;
        out.push(one(c, String(m.id), caption, null));
        for (const rep of Array.isArray(c.replies?.data) ? c.replies.data : []) if (rep?.id && rep.text) out.push(one(rep, String(m.id), caption, String(c.id)));
      }
    }
    return out;
  }

  private async conversations(a: InboxAccount, pageId: string | null, platform: "messenger" | "instagram"): Promise<InboxEvent[]> {
    if (!pageId) return [];
    const fields = encodeURIComponent("participants,messages.limit(20){id,message,from,created_time}");
    const r = await this.graph(`/${pageId}/conversations?platform=${platform}&fields=${fields}&limit=20`, { token: a.accessToken });
    const out: InboxEvent[] = [];
    for (const conv of Array.isArray(r.data) ? r.data : []) {
      const people: any[] = Array.isArray(conv.participants?.data) ? conv.participants.data : [];
      const customer = people.find((p) => p?.id && p.id !== a.externalId && p.id !== pageId);
      if (!customer) continue;
      for (const m of Array.isArray(conv.messages?.data) ? conv.messages.data : []) {
        if (!m?.id || !m.message) continue;
        const fromUs = m.from?.id === a.externalId || m.from?.id === pageId;
        out.push({
          platform: a.platform === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK",
          accountExternalId: a.externalId,
          kind: "DM",
          direction: fromUs ? "OUT" : "IN",
          externalId: String(m.id),
          threadKey: String(customer.id),
          parentExternalId: null,
          postExternalId: null,
          postCaption: null,
          authorId: m.from?.id ?? null,
          authorName: fromUs ? null : (customer.name ?? customer.username ?? m.from?.name ?? m.from?.username ?? null),
          text: String(m.message),
          createdAt: new Date(m.created_time ?? Date.now()),
        });
      }
    }
    return out;
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
