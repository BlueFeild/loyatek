import { ValidationError } from "../../core/errors";
import { SocialPlatformError, type DiscoveredAccount, type PublishAccount, type PublishContent, type PublishResult, type SocialPublisher } from "./social-types";

// Bluesky (بروتوكول AT): الربط بالـ handle + App Password (مش الباسورد الأساسي)، والنشر نص + صورة.
// الـ App Password بيتخزن متشفّر زي أي توكن، وكل نشر بيعمل جلسة جديدة
export const BLUESKY_LIMITS = {
  textMax: 300, // حروف (graphemes)
  imageMaxBytes: 1_000_000,
} as const;

const service = () => (process.env.BLUESKY_SERVICE_URL || "https://bsky.social").replace(/\/+$/, "");

export function graphemeLength(text: string): number {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<unknown> } }).Segmenter;
  if (!Seg) return [...text].length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(text)) n++;
  return n;
}

type Facet = { index: { byteStart: number; byteEnd: number }; features: Record<string, string>[] };

// لينكات وهاشتاجات قابلة للضغط (Bluesky بيطلب مكانها بالـ bytes مش بالحروف)
export function buildFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  const bytePos = (i: number) => Buffer.byteLength(text.slice(0, i), "utf8");
  const urlRe = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?;:]/g;
  for (const m of text.matchAll(urlRe)) {
    const start = m.index ?? 0;
    facets.push({ index: { byteStart: bytePos(start), byteEnd: bytePos(start + m[0].length) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  const tagRe = /(^|\s)#([\p{L}\p{N}_]{1,64})/gu;
  for (const m of text.matchAll(tagRe)) {
    const start = (m.index ?? 0) + m[1].length;
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue;
    facets.push({ index: { byteStart: bytePos(start), byteEnd: bytePos(start + 1 + tag.length) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  return facets;
}

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
}

async function xrpc<T>(path: string, init: { method?: string; token?: string; json?: unknown; body?: Buffer; contentType?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: string | Uint8Array | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.body) {
    headers["Content-Type"] = init.contentType ?? "application/octet-stream";
    body = new Uint8Array(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${service()}/xrpc/${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new SocialPlatformError("Couldn't reach Bluesky — try again in a minute.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) {
    if (res.status === 401 || data.error === "AuthenticationRequired" || data.error === "ExpiredToken") {
      throw new SocialPlatformError("Bluesky refused the login — create a new App Password and connect again.", true);
    }
    throw new SocialPlatformError(`Bluesky: ${data.message || data.error || `error ${res.status}`}`);
  }
  return data;
}

export class BlueskyGateway implements SocialPublisher {
  private async login(identifier: string, appPassword: string): Promise<Session> {
    try {
      return await xrpc<Session>("com.atproto.server.createSession", { json: { identifier, password: appPassword } });
    } catch (err) {
      if (err instanceof SocialPlatformError && err.needsReconnect) throw new ValidationError("Bluesky didn't accept this handle / App Password. Check them and try again.");
      throw err;
    }
  }

  // الربط: بنتأكد إن الـ handle والـ App Password صح ونجيب الاسم والصورة
  async connect(handle: string, appPassword: string): Promise<DiscoveredAccount> {
    const identifier = handle.trim().replace(/^@/, "");
    const s = await this.login(identifier, appPassword.trim());
    const profile = await xrpc<{ displayName?: string; avatar?: string }>(`app.bsky.actor.getProfile?actor=${encodeURIComponent(s.did)}`, { token: s.accessJwt }).catch(() => ({}) as { displayName?: string; avatar?: string });
    return {
      platform: "BLUESKY",
      externalId: s.did,
      name: profile.displayName?.trim() || s.handle,
      username: s.handle,
      pictureUrl: profile.avatar ?? null,
      parentId: null,
      // الـ App Password نفسه (بيتشفّر قبل الحفظ)
      accessToken: appPassword.trim(),
      tokenExpiresAt: null,
    };
  }

  async publish(account: PublishAccount, content: PublishContent): Promise<PublishResult> {
    const text = content.caption.trim();
    if (graphemeLength(text) > BLUESKY_LIMITS.textMax) throw new SocialPlatformError(`Bluesky posts can be up to ${BLUESKY_LIMITS.textMax} characters.`);
    if (content.media?.kind === "video") throw new SocialPlatformError("Bluesky: video isn't supported here yet — post a photo or text.");
    const s = await this.login(account.username || account.externalId, account.accessToken);

    let embed: Record<string, unknown> | undefined;
    if (content.media) {
      const bytes = content.media.load ? await content.media.load() : null;
      if (!bytes) throw new SocialPlatformError("The photo file is missing — upload it again.");
      if (bytes.length > BLUESKY_LIMITS.imageMaxBytes) throw new SocialPlatformError("Bluesky photos must be under 1 MB — use a smaller photo.");
      const up = await xrpc<{ blob: unknown }>("com.atproto.repo.uploadBlob", { token: s.accessJwt, body: bytes, contentType: content.media.mimeType || "image/jpeg" });
      embed = { $type: "app.bsky.embed.images", images: [{ alt: "", image: up.blob }] };
    }
    const facets = buildFacets(text);
    const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString() };
    if (facets.length) record.facets = facets;
    if (embed) record.embed = embed;
    const r = await xrpc<{ uri: string; cid: string }>("com.atproto.repo.createRecord", { token: s.accessJwt, json: { repo: s.did, collection: "app.bsky.feed.post", record } });
    const rkey = r.uri.split("/").pop() ?? "";
    return { externalPostId: r.uri, permalink: rkey ? `https://bsky.app/profile/${s.handle}/post/${rkey}` : null };
  }
}
