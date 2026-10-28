import { Prisma, PrismaClient } from "@prisma/client";
import type { AdTargeting } from "./ads-types";

// اللي خدمة الإعلانات محتاجاه من التخزين (Prisma هنا، ونسخة في الذاكرة للاختبارات)

export interface StoredAdsAuth {
  accessToken: string; // متشفّر
  tokenExpiresAt: Date | null;
}

// البوست اللي اتنشر وعايزين نموّله (هدف واحد = صفحة واحدة / حساب انستجرام واحد)
export interface BoostTarget {
  targetId: string;
  status: string;
  externalPostId: string | null;
  permalink: string | null;
  caption: string;
  accountId: string;
  accountName: string;
  platform: string;
  accountExternalId: string;
  // انستجرام: صفحة فيسبوك المربوطة بيه
  accountParentId: string | null;
  accountStatus: string;
}

export interface AdCampaignRow {
  id: string;
  tenantId: string;
  accountId: string | null;
  accountName: string | null;
  platform: string;
  postExternalId: string;
  permalink: string | null;
  caption: string | null;
  adAccountId: string;
  adAccountName: string | null;
  currency: string;
  objective: string;
  dailyBudget: number;
  startAt: Date;
  endAt: Date;
  targeting: AdTargeting;
  status: string;
  metaStatus: string | null;
  reviewFeedback: string | null;
  error: string | null;
  metaCampaignId: string | null;
  metaAdSetId: string | null;
  metaAdId: string | null;
  impressions: number;
  reach: number;
  clicks: number;
  engagements: number;
  spend: number;
  syncedAt: Date | null;
  createdAt: Date;
}

export interface NewAdCampaign {
  tenantId: string;
  accountId: string;
  platform: string;
  postExternalId: string;
  permalink: string | null;
  caption: string | null;
  adAccountId: string;
  adAccountName: string | null;
  currency: string;
  objective: string;
  dailyBudget: number;
  startAt: Date;
  endAt: Date;
  targeting: AdTargeting;
  createdById: string | null;
}

export type AdCampaignPatch = Partial<
  Pick<
    AdCampaignRow,
    "status" | "metaStatus" | "reviewFeedback" | "error" | "metaCampaignId" | "metaAdSetId" | "metaAdId" | "dailyBudget" | "impressions" | "reach" | "clicks" | "engagements" | "spend" | "syncedAt"
  > & { metaCreativeId: string | null }
>;

export interface AdEventView {
  action: string;
  userId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AdsStore {
  saveAuth(tenantId: string, auth: StoredAdsAuth & { connectedById: string | null }): Promise<void>;
  getAuth(tenantId: string): Promise<StoredAdsAuth | null>;
  boostTarget(tenantId: string, targetId: string): Promise<BoostTarget | null>;
  // نفس البوست بيتعمل له إعلان دلوقتي (نفس الضغطة اتبعتت مرتين)
  creatingSince(tenantId: string, postExternalId: string, since: Date): Promise<boolean>;
  createCampaign(c: NewAdCampaign): Promise<string>;
  updateCampaign(id: string, patch: AdCampaignPatch): Promise<void>;
  getCampaign(tenantId: string, id: string): Promise<AdCampaignRow | null>;
  listCampaigns(tenantId: string): Promise<AdCampaignRow[]>;
  addEvent(e: { tenantId: string; campaignId: string; userId: string | null; action: string; details?: Record<string, unknown> }): Promise<void>;
  events(tenantId: string, campaignId: string): Promise<AdEventView[]>;
}

const campaignInclude = { account: { select: { name: true } } } as const;

function toRow(c: any): AdCampaignRow {
  return {
    id: c.id,
    tenantId: c.tenantId,
    accountId: c.accountId,
    accountName: c.account?.name ?? null,
    platform: c.platform,
    postExternalId: c.postExternalId,
    permalink: c.permalink,
    caption: c.caption,
    adAccountId: c.adAccountId,
    adAccountName: c.adAccountName,
    currency: c.currency,
    objective: c.objective,
    dailyBudget: Number(c.dailyBudget),
    startAt: c.startAt,
    endAt: c.endAt,
    targeting: c.targeting as AdTargeting,
    status: c.status,
    metaStatus: c.metaStatus,
    reviewFeedback: c.reviewFeedback,
    error: c.error,
    metaCampaignId: c.metaCampaignId,
    metaAdSetId: c.metaAdSetId,
    metaAdId: c.metaAdId,
    impressions: c.impressions,
    reach: c.reach,
    clicks: c.clicks,
    engagements: c.engagements,
    spend: Number(c.spend),
    syncedAt: c.syncedAt,
    createdAt: c.createdAt,
  };
}

// الوصول لقاعدة البيانات بس - كل حاجة بشركة صاحب الطلب
export class PrismaAdsRepository implements AdsStore {
  constructor(private readonly db: PrismaClient) {}

  async saveAuth(tenantId: string, auth: StoredAdsAuth & { connectedById: string | null }) {
    await this.db.socialAdsAuth.upsert({ where: { tenantId }, create: { tenantId, ...auth }, update: auth });
  }

  getAuth(tenantId: string) {
    return this.db.socialAdsAuth.findUnique({ where: { tenantId }, select: { accessToken: true, tokenExpiresAt: true } });
  }

  async boostTarget(tenantId: string, targetId: string) {
    const t = await this.db.socialPostTarget.findFirst({
      where: { id: targetId, post: { tenantId } },
      select: {
        id: true,
        status: true,
        externalPostId: true,
        permalink: true,
        post: { select: { caption: true } },
        account: { select: { id: true, name: true, platform: true, externalId: true, parentId: true, status: true } },
      },
    });
    if (!t) return null;
    return {
      targetId: t.id,
      status: t.status,
      externalPostId: t.externalPostId,
      permalink: t.permalink,
      caption: t.post.caption,
      accountId: t.account.id,
      accountName: t.account.name,
      platform: t.account.platform,
      accountExternalId: t.account.externalId,
      accountParentId: t.account.parentId,
      accountStatus: t.account.status,
    };
  }

  async creatingSince(tenantId: string, postExternalId: string, since: Date) {
    const n = await this.db.socialAdCampaign.count({ where: { tenantId, postExternalId, status: "CREATING", createdAt: { gte: since } } });
    return n > 0;
  }

  async createCampaign(c: NewAdCampaign) {
    const row = await this.db.socialAdCampaign.create({
      data: { ...c, targeting: c.targeting as unknown as Prisma.InputJsonValue, dailyBudget: new Prisma.Decimal(c.dailyBudget) },
      select: { id: true },
    });
    return row.id;
  }

  async updateCampaign(id: string, patch: AdCampaignPatch) {
    const { dailyBudget, spend, ...rest } = patch;
    await this.db.socialAdCampaign.update({
      where: { id },
      data: { ...rest, ...(dailyBudget !== undefined ? { dailyBudget: new Prisma.Decimal(dailyBudget) } : {}), ...(spend !== undefined ? { spend: new Prisma.Decimal(spend) } : {}) },
    });
  }

  async getCampaign(tenantId: string, id: string) {
    const c = await this.db.socialAdCampaign.findFirst({ where: { id, tenantId }, include: campaignInclude });
    return c ? toRow(c) : null;
  }

  async listCampaigns(tenantId: string) {
    const rows = await this.db.socialAdCampaign.findMany({ where: { tenantId }, include: campaignInclude, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map(toRow);
  }

  async addEvent(e: { tenantId: string; campaignId: string; userId: string | null; action: string; details?: Record<string, unknown> }) {
    await this.db.socialAdEvent.create({ data: { ...e, details: (e.details ?? undefined) as Prisma.InputJsonValue | undefined } });
  }

  async events(tenantId: string, campaignId: string) {
    const rows = await this.db.socialAdEvent.findMany({ where: { tenantId, campaignId }, orderBy: { createdAt: "desc" }, take: 50, select: { action: true, userId: true, details: true, createdAt: true } });
    return rows.map((r) => ({ ...r, details: (r.details as Record<string, unknown> | null) ?? null }));
  }
}
