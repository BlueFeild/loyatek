import { Prisma, PrismaClient } from "@prisma/client";
import type { DiscoveredAccount, PostOptions, SocialPlatform } from "./social-types";

// اللي خدمات النشر محتاجاه من التخزين (Prisma هنا، ونسخة في الذاكرة للاختبارات)

export interface AccountView {
  id: string;
  platform: string;
  externalId: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  status: string;
  lastError: string | null;
  createdAt: Date;
}

export interface AccountForPublish {
  id: string;
  tenantId: string;
  platform: SocialPlatform;
  externalId: string;
  username: string | null;
  accessToken: string; // متشفّر
  tokenExpiresAt: Date | null;
  refreshToken: string | null; // متشفّر
  status: string;
}

export interface StoredTokens {
  accessToken: string; // متشفّر
  tokenExpiresAt: Date | null;
  refreshToken: string | null; // متشفّر
  refreshExpiresAt: Date | null;
}

export interface MediaRef {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  publicKey: string;
}

export interface TargetView {
  id: string;
  accountId: string;
  platform: string;
  accountName: string;
  status: string;
  permalink: string | null;
  error: string | null;
  publishedAt: Date | null;
}

export interface PostView {
  id: string;
  caption: string;
  status: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  options: PostOptions | null;
  media: { id: string; kind: string } | null;
  targets: TargetView[];
}

export interface PostForPublish {
  id: string;
  tenantId: string;
  caption: string;
  options: PostOptions | null;
  media: MediaRef | null;
  targets: { id: string; accountId: string; status: string }[];
}

export interface NewPost {
  tenantId: string;
  createdById: string | null;
  caption: string;
  mediaId: string | null;
  status: "DRAFT" | "SCHEDULED";
  scheduledAt: Date | null;
  options: PostOptions | null;
  accountIds: string[];
}

export type PostPatch = Partial<Pick<NewPost, "caption" | "mediaId" | "status" | "scheduledAt" | "accountIds" | "options">>;

export const EDITABLE_STATUSES = ["DRAFT", "SCHEDULED", "FAILED"];

export interface SocialStore {
  upsertAccounts(tenantId: string, userId: string | null, accounts: DiscoveredAccount[]): Promise<void>;
  listAccounts(tenantId: string): Promise<AccountView[]>;
  accountsByIds(tenantId: string, ids: string[]): Promise<{ id: string; platform: string; status: string }[]>;
  accountForPublish(id: string): Promise<AccountForPublish | null>;
  markAccount(id: string, status: string, lastError: string | null): Promise<void>;
  updateTokens(id: string, tokens: StoredTokens): Promise<void>;
  disconnectAccount(tenantId: string, id: string): Promise<boolean>;

  saveMedia(m: { tenantId: string; kind: "image" | "video"; mimeType: string; data: Buffer; publicKey: string }): Promise<{ id: string; kind: string; size: number }>;
  mediaRef(tenantId: string, id: string): Promise<MediaRef | null>;
  mediaByKey(publicKey: string): Promise<{ id: string; mimeType: string; size: number; data: Buffer } | null>;
  mediaData(id: string): Promise<Buffer | null>;

  createPost(p: NewPost): Promise<string>;
  // بيعدّل بس لو البوست لسه في حالة تتعدّل (EDITABLE_STATUSES). false = اتنشر / بيتنشر
  updatePost(tenantId: string, id: string, patch: PostPatch): Promise<boolean>;
  getPost(tenantId: string, id: string): Promise<PostView | null>;
  listPosts(tenantId: string, range: { from?: Date; to?: Date }): Promise<PostView[]>;
  deletePost(tenantId: string, id: string): Promise<boolean>;

  // قفل ذرّي: SCHEDULED ← PUBLISHING. false = حد تاني بينشره أو اتلغى
  claim(id: string, now: Date): Promise<boolean>;
  postForPublish(id: string): Promise<PostForPublish | null>;
  finishTarget(targetId: string, r: { status: "PUBLISHED" | "FAILED"; externalPostId?: string; permalink?: string | null; error?: string | null; publishedAt?: Date }): Promise<void>;
  finishPost(id: string, status: "PUBLISHED" | "PARTIAL" | "FAILED", publishedAt: Date | null): Promise<void>;
  dueIds(now: Date, limit: number): Promise<string[]>;
  // FAILED / PARTIAL ← SCHEDULED (الأهداف اللي فشلت بس ترجع PENDING)
  retry(tenantId: string, id: string, at: Date): Promise<boolean>;
  expireStale(before: Date): Promise<number>;
}

const postInclude = {
  media: { select: { id: true, kind: true } },
  targets: { include: { account: { select: { platform: true, name: true } } } },
} as const;

function toView(p: any): PostView {
  return {
    id: p.id,
    caption: p.caption,
    status: p.status,
    scheduledAt: p.scheduledAt,
    publishedAt: p.publishedAt,
    createdAt: p.createdAt,
    options: (p.options as PostOptions | null) ?? null,
    media: p.media,
    targets: p.targets.map((t: any) => ({
      id: t.id,
      accountId: t.accountId,
      platform: t.account.platform,
      accountName: t.account.name,
      status: t.status,
      permalink: t.permalink,
      error: t.error,
      publishedAt: t.publishedAt,
    })),
  };
}

// الوصول لقاعدة البيانات بس - مفيش منطق هنا. كل حاجة بشركة صاحب الطلب
export class PrismaSocialRepository implements SocialStore {
  constructor(private readonly db: PrismaClient) {}

  async upsertAccounts(tenantId: string, userId: string | null, accounts: DiscoveredAccount[]) {
    await this.db.$transaction(
      accounts.map((a) => {
        const data = {
          name: a.name,
          username: a.username,
          pictureUrl: a.pictureUrl,
          parentId: a.parentId,
          accessToken: a.accessToken,
          tokenExpiresAt: a.tokenExpiresAt,
          refreshToken: a.refreshToken ?? null,
          refreshExpiresAt: a.refreshExpiresAt ?? null,
          status: "ACTIVE",
          lastError: null,
          connectedById: userId,
        };
        return this.db.socialAccount.upsert({
          where: { tenantId_platform_externalId: { tenantId, platform: a.platform, externalId: a.externalId } },
          create: { tenantId, platform: a.platform, externalId: a.externalId, ...data },
          update: data,
        });
      })
    );
  }

  listAccounts(tenantId: string) {
    return this.db.socialAccount.findMany({
      where: { tenantId, status: { not: "DISCONNECTED" } },
      select: { id: true, platform: true, externalId: true, name: true, username: true, pictureUrl: true, status: true, lastError: true, createdAt: true },
      orderBy: [{ platform: "asc" }, { name: "asc" }],
    });
  }

  accountsByIds(tenantId: string, ids: string[]) {
    return this.db.socialAccount.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, platform: true, status: true } });
  }

  async accountForPublish(id: string) {
    const a = await this.db.socialAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true, platform: true, externalId: true, username: true, accessToken: true, tokenExpiresAt: true, refreshToken: true, status: true },
    });
    return a ? { ...a, platform: a.platform as SocialPlatform } : null;
  }

  async markAccount(id: string, status: string, lastError: string | null) {
    await this.db.socialAccount.update({ where: { id }, data: { status, lastError } });
  }

  async updateTokens(id: string, tokens: StoredTokens) {
    await this.db.socialAccount.update({ where: { id }, data: tokens });
  }

  async disconnectAccount(tenantId: string, id: string) {
    const r = await this.db.socialAccount.updateMany({ where: { id, tenantId }, data: { status: "DISCONNECTED", accessToken: "", refreshToken: null, lastError: null } });
    return r.count > 0;
  }

  async saveMedia(m: { tenantId: string; kind: "image" | "video"; mimeType: string; data: Buffer; publicKey: string }) {
    return this.db.socialMedia.create({ data: { ...m, size: m.data.length }, select: { id: true, kind: true, size: true } });
  }

  async mediaRef(tenantId: string, id: string) {
    const m = await this.db.socialMedia.findFirst({ where: { id, tenantId }, select: { id: true, kind: true, mimeType: true, publicKey: true } });
    return m ? { ...m, kind: m.kind as "image" | "video" } : null;
  }

  async mediaByKey(publicKey: string) {
    const m = await this.db.socialMedia.findUnique({ where: { publicKey }, select: { id: true, mimeType: true, size: true, data: true } });
    return m ? { ...m, data: m.data as Buffer } : null;
  }

  async mediaData(id: string) {
    const m = await this.db.socialMedia.findUnique({ where: { id }, select: { data: true } });
    return m ? (m.data as Buffer) : null;
  }

  async createPost(p: NewPost) {
    const row = await this.db.socialPost.create({
      data: {
        tenantId: p.tenantId,
        createdById: p.createdById,
        caption: p.caption,
        mediaId: p.mediaId,
        status: p.status,
        scheduledAt: p.scheduledAt,
        options: (p.options ?? undefined) as Prisma.InputJsonValue | undefined,
        targets: { create: p.accountIds.map((accountId) => ({ accountId })) },
      },
      select: { id: true },
    });
    return row.id;
  }

  async updatePost(tenantId: string, id: string, patch: PostPatch) {
    const { accountIds, options, ...rest } = patch;
    const fields = { ...rest, ...(options !== undefined ? { options: (options ?? Prisma.JsonNull) as Prisma.InputJsonValue } : {}) };
    return this.db.$transaction(async (tx) => {
      const r = await tx.socialPost.updateMany({ where: { id, tenantId, status: { in: EDITABLE_STATUSES } }, data: fields });
      if (r.count === 0) return false;
      if (accountIds) {
        await tx.socialPostTarget.deleteMany({ where: { postId: id } });
        await tx.socialPostTarget.createMany({ data: accountIds.map((accountId) => ({ postId: id, accountId })) });
      } else if (fields.status === "SCHEDULED") {
        // تعديل بوست فشل وإعادة جدولته: كل الأهداف تتنشر من الأول
        await tx.socialPostTarget.updateMany({ where: { postId: id, status: "FAILED" }, data: { status: "PENDING", error: null } });
      }
      return true;
    });
  }

  async getPost(tenantId: string, id: string) {
    const p = await this.db.socialPost.findFirst({ where: { id, tenantId }, include: postInclude });
    return p ? toView(p) : null;
  }

  async listPosts(tenantId: string, range: { from?: Date; to?: Date }) {
    const when = range.from || range.to ? { gte: range.from, lt: range.to } : undefined;
    const rows = await this.db.socialPost.findMany({
      where: { tenantId, ...(when ? { OR: [{ scheduledAt: when }, { scheduledAt: null, createdAt: when }] } : {}) },
      include: postInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map(toView);
  }

  async deletePost(tenantId: string, id: string) {
    const r = await this.db.socialPost.deleteMany({ where: { id, tenantId, status: { not: "PUBLISHING" } } });
    return r.count > 0;
  }

  async claim(id: string, now: Date) {
    const r = await this.db.socialPost.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "PUBLISHING", publishingAt: now } });
    return r.count > 0;
  }

  async postForPublish(id: string) {
    const p = await this.db.socialPost.findUnique({
      where: { id },
      select: { id: true, tenantId: true, caption: true, options: true, media: { select: { id: true, kind: true, mimeType: true, publicKey: true } }, targets: { select: { id: true, accountId: true, status: true } } },
    });
    if (!p) return null;
    return { ...p, options: (p.options as PostOptions | null) ?? null, media: p.media ? { ...p.media, kind: p.media.kind as "image" | "video" } : null };
  }

  async finishTarget(targetId: string, r: { status: "PUBLISHED" | "FAILED"; externalPostId?: string; permalink?: string | null; error?: string | null; publishedAt?: Date }) {
    await this.db.socialPostTarget.update({ where: { id: targetId }, data: r });
  }

  async finishPost(id: string, status: "PUBLISHED" | "PARTIAL" | "FAILED", publishedAt: Date | null) {
    await this.db.socialPost.update({ where: { id }, data: { status, publishedAt, publishingAt: null } });
  }

  async dueIds(now: Date, limit: number) {
    const rows = await this.db.socialPost.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now }, tenant: { accountStatus: "ACTIVE" } },
      select: { id: true },
      orderBy: { scheduledAt: "asc" },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  async retry(tenantId: string, id: string, at: Date) {
    return this.db.$transaction(async (tx) => {
      const r = await tx.socialPost.updateMany({ where: { id, tenantId, status: { in: ["FAILED", "PARTIAL"] } }, data: { status: "SCHEDULED", scheduledAt: at } });
      if (r.count === 0) return false;
      await tx.socialPostTarget.updateMany({ where: { postId: id, status: "FAILED" }, data: { status: "PENDING", error: null } });
      return true;
    });
  }

  // البوستات اللي اتقطعت في النص (السيرفر اتعاد تشغيله): الأهداف اللي ماخلصتش = FAILED،
  // وبنقول للتاجر يبص على الصفحة قبل ما يعيد (ممكن تكون نزلت فعلًا)
  async expireStale(before: Date) {
    const stale = await this.db.socialPost.findMany({ where: { status: "PUBLISHING", publishingAt: { lt: before } }, select: { id: true, targets: { select: { status: true } } } });
    for (const p of stale) {
      await this.db.socialPostTarget.updateMany({
        where: { postId: p.id, status: "PENDING" },
        data: { status: "FAILED", error: "Publishing was interrupted — check your page before trying again." },
      });
      const anyPublished = p.targets.some((t) => t.status === "PUBLISHED");
      await this.db.socialPost.updateMany({ where: { id: p.id, status: "PUBLISHING" }, data: { status: anyPublished ? "PARTIAL" : "FAILED", publishingAt: null } });
    }
    return stale.length;
  }
}
