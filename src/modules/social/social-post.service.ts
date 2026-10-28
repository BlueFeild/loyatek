import crypto from "crypto";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import type { PostPatch, SocialStore } from "./social.repository";
import type { PostInput } from "./social.schemas";
import { SOCIAL_LIMITS, SOCIAL_MEDIA_TYPES, SocialPlatformError, type PostOptions, type SocialPublisher } from "./social-types";
import { SocialTokenService } from "./social-token.service";

// المنصات اللي النشر عليها شغال دلوقتي (سناب لسه)
const PUBLISHABLE = new Set(["FACEBOOK", "INSTAGRAM", "TIKTOK"]);
const TIKTOK_CAPTION_MAX = 2200;

// البوستات: كتابة / جدولة / نشر. النشر نفسه دايمًا في الخلفية (انستجرام بياخد وقت مع الفيديو):
// "انشر دلوقتي" = SCHEDULED بميعاد دلوقتي + نبدأ على طول، والـ job بيلم أي بوست جه ميعاده
export class SocialPostService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SocialStore,
    private readonly publisher: SocialPublisher,
    // عنوان الباك إند العام (انستجرام لازم يجيب الصورة/الفيديو من لينك على النت)
    private readonly publicBaseUrl: () => string,
    private readonly now: () => Date = () => new Date(),
    private readonly tokens: SocialTokenService = new SocialTokenService(store)
  ) {}

  // ---------- الملفات ----------
  async uploadMedia(tenantId: string, mimeType: string, data: Buffer) {
    const kind = SOCIAL_MEDIA_TYPES[mimeType];
    if (!kind) throw new ValidationError("Use a JPG or PNG photo, or an MP4 / MOV video.");
    if (data.length === 0) throw new ValidationError("The file is empty");
    const max = kind === "image" ? SOCIAL_LIMITS.imageMaxBytes : SOCIAL_LIMITS.videoMaxBytes;
    if (data.length > max) throw new AppError(413, "FILE_TOO_LARGE", `The file is too large (max ${Math.round(max / 1024 / 1024)} MB).`);
    const publicKey = crypto.randomBytes(24).toString("hex");
    return this.store.saveMedia({ tenantId, kind, mimeType, data, publicKey });
  }

  mediaByKey(publicKey: string) {
    if (!/^[a-f0-9]{48}$/.test(publicKey)) return Promise.resolve(null);
    return this.store.mediaByKey(publicKey);
  }

  // ---------- البوستات ----------
  list(tenantId: string, range: { from?: Date; to?: Date }) {
    return this.store.listPosts(tenantId, range);
  }

  async get(tenantId: string, id: string) {
    const p = await this.store.getPost(tenantId, id);
    if (!p) throw new NotFoundError("Post not found");
    return p;
  }

  async create(tenantId: string, userId: string | null, input: PostInput) {
    const fields = await this.validate(tenantId, input);
    const id = await this.store.createPost({ tenantId, createdById: userId, ...fields });
    if (input.when === "now") this.start(id);
    return this.get(tenantId, id);
  }

  async update(tenantId: string, id: string, input: PostInput) {
    const fields = await this.validate(tenantId, input);
    const patch: PostPatch = fields;
    if (!(await this.store.updatePost(tenantId, id, patch))) {
      throw new AppError(409, "POST_LOCKED", "This post is already published or being published — it can't be edited.");
    }
    if (input.when === "now") this.start(id);
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string) {
    if (!(await this.store.deletePost(tenantId, id))) throw new AppError(409, "POST_LOCKED", "This post is being published right now — try again in a minute.");
    return { ok: true };
  }

  // إعادة نشر الحسابات اللي فشلت بس (اللي نزل مابيتكررش)
  async retry(tenantId: string, id: string) {
    if (!(await this.store.retry(tenantId, id, this.now()))) throw new AppError(409, "NOT_RETRYABLE", "Only failed posts can be retried.");
    this.start(id);
    return this.get(tenantId, id);
  }

  private async validate(tenantId: string, input: PostInput) {
    const now = this.now();
    const caption = input.caption.trim();
    const accountIds = [...new Set(input.accountIds)];
    const accounts = await this.store.accountsByIds(tenantId, accountIds);
    if (accounts.length !== accountIds.length) throw new ValidationError("One of the chosen accounts isn't connected to this company.");
    for (const a of accounts) {
      if (!PUBLISHABLE.has(a.platform)) throw new ValidationError(`Publishing to ${a.platform} isn't available yet.`);
      if (a.status !== "ACTIVE") throw new ValidationError("One of the chosen accounts needs to be connected again (Connect Facebook & Instagram).");
    }

    const media = input.mediaId ? await this.store.mediaRef(tenantId, input.mediaId) : null;
    if (input.mediaId && !media) throw new ValidationError("The photo/video wasn't found — upload it again.");
    const toInstagram = accounts.some((a) => a.platform === "INSTAGRAM");
    if (toInstagram && !media) throw new ValidationError("Instagram needs a photo or a video.");
    if (!media && !caption) throw new ValidationError("Write something or add a photo/video.");
    if (toInstagram && caption.length > SOCIAL_LIMITS.instagramCaptionMax) {
      throw new ValidationError(`Instagram captions can be up to ${SOCIAL_LIMITS.instagramCaptionMax} characters.`);
    }
    const options: PostOptions = {};
    if (accounts.some((a) => a.platform === "TIKTOK")) {
      if (!media) throw new ValidationError("TikTok needs a video or a photo.");
      if (media.kind === "image" && media.mimeType !== "image/jpeg") throw new ValidationError("TikTok photos must be JPG — upload the photo again.");
      if (caption.length > TIKTOK_CAPTION_MAX) throw new ValidationError(`TikTok captions can be up to ${TIKTOK_CAPTION_MAX} characters.`);
      const t = input.options?.tiktok;
      // شرط تيك توك: التاجر يختار بنفسه مين يشوف البوست (مفيش اختيار افتراضي)
      if (!t?.privacyLevel) throw new ValidationError("Choose who can see the TikTok post.");
      if (t.brandedContent && t.privacyLevel === "SELF_ONLY") throw new ValidationError("Branded content can't be private on TikTok — choose another “who can see it”.");
      options.tiktok = t;
    }

    let scheduledAt: Date | null = null;
    if (input.when === "now") scheduledAt = now;
    else if (input.scheduledAt) {
      scheduledAt = input.scheduledAt;
      if (input.when === "schedule") {
        if (scheduledAt.getTime() < now.getTime() - 60_000) throw new ValidationError("The publish time is in the past.");
        if (scheduledAt.getTime() > now.getTime() + SOCIAL_LIMITS.scheduleMaxDays * 86400000) {
          throw new ValidationError(`You can schedule up to ${SOCIAL_LIMITS.scheduleMaxDays} days ahead.`);
        }
      }
    }
    return { caption, mediaId: media?.id ?? null, accountIds, options: options.tiktok ? options : null, status: input.when === "draft" ? ("DRAFT" as const) : ("SCHEDULED" as const), scheduledAt };
  }

  // ---------- النشر ----------
  private start(id: string) {
    if (this.running.has(id)) return;
    const work = this.publishPost(id)
      .catch((err) => console.error(`[social] publishing post ${id} failed:`, err))
      .finally(() => this.running.delete(id));
    this.running.set(id, work);
  }

  // للاختبارات: نستنى أي نشر شغال في الخلفية
  async idle() {
    await Promise.all([...this.running.values()]);
  }

  // كل البوستات اللي جه ميعادها (الـ job كل دقيقة)
  async runDue(limit = 20) {
    const now = this.now();
    const expired = await this.store.expireStale(new Date(now.getTime() - SOCIAL_LIMITS.staleAfterMs));
    const ids = await this.store.dueIds(now, limit);
    let published = 0;
    for (const id of ids) {
      if (this.running.has(id)) continue;
      this.start(id);
      await this.running.get(id);
      published++;
    }
    return { expired, started: published };
  }

  async publishPost(id: string): Promise<void> {
    if (!(await this.store.claim(id, this.now()))) return;
    const post = await this.store.postForPublish(id);
    if (!post) return;
    const m = post.media;
    const media = m
      ? {
          kind: m.kind,
          url: `${this.publicBaseUrl()}/api/public/social/media/${m.publicKey}`,
          mimeType: m.mimeType,
          load: async () => {
            const data = await this.store.mediaData(m.id);
            if (!data) throw new SocialPlatformError("The photo/video file is missing — upload it again.");
            return data;
          },
        }
      : null;

    let ok = 0;
    let failed = 0;
    for (const t of post.targets) {
      if (t.status === "PUBLISHED") {
        ok++;
        continue;
      }
      const account = await this.store.accountForPublish(t.accountId);
      if (!account || account.tenantId !== post.tenantId || account.status !== "ACTIVE" || !account.accessToken) {
        failed++;
        await this.store.finishTarget(t.id, { status: "FAILED", error: "This account needs to be connected again." });
        continue;
      }
      try {
        const accessToken = await this.tokens.accessToken(account);
        const r = await this.publisher.publish(
          { platform: account.platform, externalId: account.externalId, username: account.username, accessToken },
          { caption: post.caption, media, options: post.options ?? undefined }
        );
        ok++;
        await this.store.finishTarget(t.id, { status: "PUBLISHED", externalPostId: r.externalPostId, permalink: r.permalink, error: null, publishedAt: this.now() });
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : "Publishing failed";
        await this.store.finishTarget(t.id, { status: "FAILED", error: message.slice(0, 500) });
        if (err instanceof SocialPlatformError && err.needsReconnect) await this.store.markAccount(account.id, "NEEDS_RECONNECT", message.slice(0, 500));
      }
    }
    const status = failed === 0 ? "PUBLISHED" : ok === 0 ? "FAILED" : "PARTIAL";
    await this.store.finishPost(id, status, ok > 0 ? this.now() : null);
  }
}
