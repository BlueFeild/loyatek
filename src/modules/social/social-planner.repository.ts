import { Prisma, PrismaClient } from "@prisma/client";
import { EDITABLE_STATUSES } from "./social.repository";
import type { PostOptions } from "./social-types";

// اللي الكالندر والتكرار وموافقة العميل محتاجينه من التخزين

export interface PlannerPost {
  id: string;
  tenantId: string;
  createdById: string | null;
  caption: string;
  mediaId: string | null;
  status: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  options: PostOptions | null;
  repeatEvery: string | null;
  repeatUntil: Date | null;
  seriesId: string | null;
  approvalStatus: string | null;
  accountIds: string[];
}

export interface ApprovalView {
  id: string;
  tenantId: string;
  caption: string;
  status: string;
  scheduledAt: Date | null;
  approvalStatus: string | null;
  approvalNote: string | null;
  approvalBy: string | null;
  approvalAt: Date | null;
  media: { kind: string; publicKey: string } | null;
  targets: { platform: string; accountName: string }[];
  business: string;
}

export interface PlannerStore {
  post(tenantId: string, id: string): Promise<PlannerPost | null>;
  // بيتنقل بس لو لسه بيتعدّل (مسودة / مجدول / فشل)
  reschedule(tenantId: string, id: string, scheduledAt: Date): Promise<boolean>;
  // نسخة جديدة من البوست (بالحسابات نفسها)
  copy(p: Omit<PlannerPost, "id" | "publishedAt" | "accountIds"> & { accountIds: string[] }): Promise<string>;
  // التكرار اللي جاي متعمل قبل كده؟ (عشان مايتعملش مرتين)
  occurrenceExists(seriesId: string, scheduledAt: Date): Promise<boolean>;
  setApproval(tenantId: string, id: string, a: { status: string | null; tokenHash?: string | null; note?: string | null; by?: string | null; at?: Date | null }): Promise<boolean>;
  approvalByToken(tokenHash: string): Promise<ApprovalView | null>;
  // قرار العميل - بيتسجّل بس لو البوست لسه مستني ومش اتنشر
  decide(tokenHash: string, d: { status: "APPROVED" | "CHANGES"; note: string | null; by: string | null; at: Date }): Promise<boolean>;
}

export class PrismaPlannerRepository implements PlannerStore {
  constructor(private readonly db: PrismaClient) {}

  async post(tenantId: string, id: string) {
    const p = await this.db.socialPost.findFirst({ where: { id, tenantId }, include: { targets: { select: { accountId: true } } } });
    if (!p) return null;
    return {
      id: p.id,
      tenantId: p.tenantId,
      createdById: p.createdById,
      caption: p.caption,
      mediaId: p.mediaId,
      status: p.status,
      scheduledAt: p.scheduledAt,
      publishedAt: p.publishedAt,
      options: (p.options as PostOptions | null) ?? null,
      repeatEvery: p.repeatEvery,
      repeatUntil: p.repeatUntil,
      seriesId: p.seriesId,
      approvalStatus: p.approvalStatus,
      accountIds: p.targets.map((t) => t.accountId),
    };
  }

  async reschedule(tenantId: string, id: string, scheduledAt: Date) {
    const r = await this.db.socialPost.updateMany({ where: { id, tenantId, status: { in: ["DRAFT", "SCHEDULED", "FAILED"] } }, data: { scheduledAt } });
    if (r.count > 0) {
      // بوست فشل واتنقل لميعاد جديد = يتنشر تاني في الميعاد ده
      await this.db.socialPost.updateMany({ where: { id, status: "FAILED" }, data: { status: "SCHEDULED" } });
      await this.db.socialPostTarget.updateMany({ where: { postId: id, status: "FAILED" }, data: { status: "PENDING", error: null } });
    }
    return r.count > 0;
  }

  async copy(p: Omit<PlannerPost, "id" | "publishedAt" | "accountIds"> & { accountIds: string[] }) {
    const row = await this.db.socialPost.create({
      data: {
        tenantId: p.tenantId,
        createdById: p.createdById,
        caption: p.caption,
        mediaId: p.mediaId,
        status: p.status,
        scheduledAt: p.scheduledAt,
        options: (p.options ?? undefined) as Prisma.InputJsonValue | undefined,
        repeatEvery: p.repeatEvery,
        repeatUntil: p.repeatUntil,
        seriesId: p.seriesId,
        approvalStatus: p.approvalStatus,
        targets: { create: p.accountIds.map((accountId) => ({ accountId })) },
      },
      select: { id: true },
    });
    return row.id;
  }

  async occurrenceExists(seriesId: string, scheduledAt: Date) {
    return (await this.db.socialPost.count({ where: { seriesId, scheduledAt } })) > 0;
  }

  async setApproval(tenantId: string, id: string, a: { status: string | null; tokenHash?: string | null; note?: string | null; by?: string | null; at?: Date | null }) {
    const data: Prisma.SocialPostUpdateManyMutationInput = { approvalStatus: a.status };
    if (a.tokenHash !== undefined) data.approvalTokenHash = a.tokenHash;
    if (a.note !== undefined) data.approvalNote = a.note;
    if (a.by !== undefined) data.approvalBy = a.by;
    if (a.at !== undefined) data.approvalAt = a.at;
    const r = await this.db.socialPost.updateMany({ where: { id, tenantId, status: { in: EDITABLE_STATUSES } }, data });
    return r.count > 0;
  }

  async approvalByToken(tokenHash: string) {
    const p = await this.db.socialPost.findUnique({
      where: { approvalTokenHash: tokenHash },
      include: {
        media: { select: { kind: true, publicKey: true } },
        targets: { include: { account: { select: { platform: true, name: true } } } },
        tenant: { select: { name: true } },
      },
    });
    if (!p) return null;
    return {
      id: p.id,
      tenantId: p.tenantId,
      caption: p.caption,
      status: p.status,
      scheduledAt: p.scheduledAt,
      approvalStatus: p.approvalStatus,
      approvalNote: p.approvalNote,
      approvalBy: p.approvalBy,
      approvalAt: p.approvalAt,
      media: p.media,
      targets: p.targets.map((t) => ({ platform: t.account.platform, accountName: t.account.name })),
      business: p.tenant.name,
    };
  }

  async decide(tokenHash: string, d: { status: "APPROVED" | "CHANGES"; note: string | null; by: string | null; at: Date }) {
    const r = await this.db.socialPost.updateMany({
      where: { approvalTokenHash: tokenHash, status: { in: EDITABLE_STATUSES }, approvalStatus: { not: null } },
      data: { approvalStatus: d.status, approvalNote: d.note, approvalBy: d.by, approvalAt: d.at },
    });
    return r.count > 0;
  }
}
