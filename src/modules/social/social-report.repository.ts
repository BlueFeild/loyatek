import crypto from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { ReportInput, ReportSettingsView } from "./social-report.service";

// تقرير السوشيال: Prisma بس (الحسابات نفسها في buildReport)

const newToken = () => crypto.randomBytes(24).toString("hex");

export interface ReportRows extends ReportInput {
  company: string | null;
  accounts: { platform: string; name: string; username: string | null; pictureUrl: string | null }[];
}

export interface ReportStore {
  settings(tenantId: string): Promise<ReportSettingsView>;
  updateSettings(tenantId: string, data: Prisma.SocialReportSettingsUpdateInput): Promise<void>;
  rotate(tenantId: string): Promise<void>;
  rows(tenantId: string, range: { from: Date; to: Date }, prev: { from: Date; to: Date }): Promise<ReportRows>;
  tenantByToken(token: string): Promise<string | null>;
  dueMonthly(period: string, limit: number): Promise<{ tenantId: string; shareToken: string; recipients: string[]; brand: string }[]>;
  claimMonthly(tenantId: string, period: string): Promise<boolean>;
}

export class PrismaReportRepository implements ReportStore {
  constructor(private readonly db: PrismaClient) {}

  async settings(tenantId: string): Promise<ReportSettingsView> {
    // أول زيارة: صفحة التقارير بتطلب الإعدادات والتقرير في نفس اللحظة، فطلبين بيحاولوا يعملوا الصف مع بعض.
    // اللي يخسر السباق (P2002) يقرا الصف اللي التاني عمله بدل ما يرجع خطأ
    const s = await this.db.socialReportSettings
      .upsert({ where: { tenantId }, create: { tenantId, shareToken: newToken() }, update: {} })
      .catch(async (err: unknown) => {
        if ((err as { code?: string })?.code !== "P2002") throw err;
        return this.db.socialReportSettings.findUniqueOrThrow({ where: { tenantId } });
      });
    return { brandName: s.brandName, logoDataUrl: s.logoDataUrl, accentColor: s.accentColor, hidePlatformName: s.hidePlatformName, recipients: s.recipients, monthlyEmail: s.monthlyEmail, shareToken: s.shareToken, lastSentPeriod: s.lastSentPeriod };
  }

  async updateSettings(tenantId: string, data: Prisma.SocialReportSettingsUpdateInput) {
    await this.settings(tenantId);
    await this.db.socialReportSettings.update({ where: { tenantId }, data });
  }

  async rotate(tenantId: string) {
    await this.updateSettings(tenantId, { shareToken: newToken() });
  }

  async rows(tenantId: string, range: { from: Date; to: Date }, prev: { from: Date; to: Date }): Promise<ReportRows> {
    const [tenant, messages, targets, ads, whatsapp, prevPublished, prevIn, accounts] = await Promise.all([
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.db.socialMessage.findMany({ where: { tenantId, createdAt: { gte: range.from, lt: range.to } }, select: { kind: true, direction: true, threadKey: true, accountId: true, sentById: true, createdAt: true }, take: 20000 }),
      this.db.socialPostTarget.findMany({
        where: { post: { tenantId }, OR: [{ publishedAt: { gte: range.from, lt: range.to } }, { status: "FAILED", post: { scheduledAt: { gte: range.from, lt: range.to } } }] },
        select: { status: true, permalink: true, publishedAt: true, account: { select: { platform: true, name: true } }, post: { select: { caption: true, media: { select: { kind: true } } } } },
        take: 2000,
      }),
      this.db.socialAdCampaign.findMany({
        where: { tenantId, metaAdId: { not: null }, startAt: { lt: range.to }, endAt: { gte: range.from } },
        select: { platform: true, objective: true, status: true, currency: true, spend: true, impressions: true, reach: true, clicks: true, conversations: true },
      }),
      this.db.whatsappMessage.groupBy({ by: ["direction"], where: { tenantId, createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      this.db.socialPostTarget.count({ where: { post: { tenantId }, status: "PUBLISHED", publishedAt: { gte: prev.from, lt: prev.to } } }),
      this.db.socialMessage.count({ where: { tenantId, direction: "IN", createdAt: { gte: prev.from, lt: prev.to } } }),
      this.db.socialAccount.findMany({ where: { tenantId, status: { not: "DISCONNECTED" } }, select: { platform: true, name: true, username: true, pictureUrl: true } }),
    ]);
    return {
      company: tenant?.name ?? null,
      accounts,
      messages,
      targets: targets.map((t) => ({ platform: t.account.platform, accountName: t.account.name, status: t.status, permalink: t.permalink, publishedAt: t.publishedAt, caption: t.post.caption, mediaKind: t.post.media?.kind ?? null })),
      ads: ads.map((a) => ({ ...a, spend: Number(a.spend) })),
      whatsapp: whatsapp.map((w) => ({ direction: w.direction, count: w._count._all })),
      previous: { published: prevPublished, messagesIn: prevIn },
    };
  }

  async tenantByToken(token: string) {
    const s = await this.db.socialReportSettings.findUnique({ where: { shareToken: token }, select: { tenantId: true, tenant: { select: { accountStatus: true } } } });
    return s && s.tenant.accountStatus === "ACTIVE" ? s.tenantId : null;
  }

  async dueMonthly(period: string, limit: number) {
    const rows = await this.db.socialReportSettings.findMany({
      where: { monthlyEmail: true, NOT: { recipients: { isEmpty: true } }, OR: [{ lastSentPeriod: null }, { lastSentPeriod: { not: period } }], tenant: { accountStatus: "ACTIVE" } },
      select: { tenantId: true, shareToken: true, recipients: true, brandName: true, tenant: { select: { name: true } } },
      take: limit,
    });
    return rows.map((r) => ({ tenantId: r.tenantId, shareToken: r.shareToken, recipients: r.recipients, brand: r.brandName || r.tenant.name }));
  }

  // قفل ذرّي: لو سيرفرين شغالين، واحد بس يبعت
  async claimMonthly(tenantId: string, period: string) {
    const r = await this.db.socialReportSettings.updateMany({ where: { tenantId, OR: [{ lastSentPeriod: null }, { lastSentPeriod: { not: period } }] }, data: { lastSentPeriod: period } });
    return r.count > 0;
  }
}
