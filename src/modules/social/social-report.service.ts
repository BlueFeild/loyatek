import { NotFoundError, ValidationError } from "../../core/errors";
import { isValidEmail } from "../../utils/email";
import { monthRange } from "../../utils/period";
import type { ReportStore } from "./social-report.repository";

// تقرير السوشيال الشهري (زي Metricool): النشر + التعليقات والرسايل + الإعلانات + واتساب،
// باسم ولوجو الوكالة (White label)، ولينك عام يتبعت للعميل ويتحفظ PDF من المتصفح

export const REPORT_LIMITS = { maxRecipients: 10, logoMaxChars: 400_000, maxListedPosts: 60 } as const;

export interface ReportSettingsView {
  brandName: string | null;
  logoDataUrl: string | null;
  accentColor: string | null;
  hidePlatformName: boolean;
  recipients: string[];
  monthlyEmail: boolean;
  shareToken: string;
  lastSentPeriod: string | null;
}

export interface ReportInput {
  messages: { kind: string; direction: string; threadKey: string; accountId: string; sentById: string | null; createdAt: Date }[];
  targets: { platform: string; accountName: string; status: string; permalink: string | null; publishedAt: Date | null; caption: string; mediaKind: string | null }[];
  ads: { platform: string; objective: string; status: string; currency: string; spend: number; impressions: number; reach: number; clicks: number; conversations: number }[];
  whatsapp: { direction: string; count: number }[];
  previous: { published: number; messagesIn: number };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// الأرقام نفسها (دالة نقية - بتتختبر لوحدها)
export function buildReport(input: ReportInput) {
  const published = input.targets.filter((t) => t.status === "PUBLISHED");
  const byPlatform: Record<string, { published: number; failed: number }> = {};
  for (const t of input.targets) {
    const row = (byPlatform[t.platform] ??= { published: 0, failed: 0 });
    if (t.status === "PUBLISHED") row.published++;
    else if (t.status === "FAILED") row.failed++;
  }

  const inbound = input.messages.filter((m) => m.direction === "IN");
  const staffReplies = input.messages.filter((m) => m.direction === "OUT" && m.sentById);
  // سرعة الرد: من أول رسالة جاية في المحادثة لحد أول رد بعدها
  const threads = new Map<string, { firstIn: number | null; firstReply: number | null }>();
  for (const m of [...input.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = `${m.accountId}|${m.kind}|${m.threadKey}`;
    const t = threads.get(key) ?? { firstIn: null, firstReply: null };
    if (m.direction === "IN" && t.firstIn === null) t.firstIn = m.createdAt.getTime();
    else if (m.direction === "OUT" && t.firstIn !== null && t.firstReply === null) t.firstReply = m.createdAt.getTime();
    threads.set(key, t);
  }
  const waits = [...threads.values()].filter((t) => t.firstIn !== null && t.firstReply !== null).map((t) => (t.firstReply! - t.firstIn!) / 60000);
  const answered = [...threads.values()].filter((t) => t.firstIn !== null);

  const spendByCurrency: Record<string, number> = {};
  for (const a of input.ads) spendByCurrency[a.currency] = round1((spendByCurrency[a.currency] ?? 0) + a.spend);
  const sum = (k: "impressions" | "reach" | "clicks" | "conversations") => input.ads.reduce((n, a) => n + a[k], 0);

  const waIn = input.whatsapp.find((w) => w.direction === "IN")?.count ?? 0;
  const waOut = input.whatsapp.find((w) => w.direction === "OUT")?.count ?? 0;

  return {
    publishing: {
      published: published.length,
      failed: input.targets.filter((t) => t.status === "FAILED").length,
      previousPublished: input.previous.published,
      byPlatform,
      posts: published
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
        .slice(0, REPORT_LIMITS.maxListedPosts)
        .map((t) => ({ platform: t.platform, account: t.accountName, caption: t.caption.slice(0, 220), permalink: t.permalink, publishedAt: t.publishedAt, mediaKind: t.mediaKind })),
    },
    inbox: {
      comments: inbound.filter((m) => m.kind === "COMMENT").length,
      messages: inbound.filter((m) => m.kind === "DM").length,
      previousIn: input.previous.messagesIn,
      replies: staffReplies.length,
      conversations: answered.length,
      answeredPct: answered.length ? Math.round((waits.length / answered.length) * 100) : null,
      avgFirstReplyMinutes: waits.length ? round1(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    },
    ads: {
      campaigns: input.ads.length,
      spendByCurrency,
      impressions: sum("impressions"),
      reach: sum("reach"),
      clicks: sum("clicks"),
      whatsappChats: sum("conversations"),
    },
    whatsapp: { received: waIn, sent: waOut },
  };
}

export function previousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class SocialReportService {
  constructor(
    private readonly store: ReportStore,
    private readonly opts: { frontendBaseUrl: () => string; sendEmail: (to: string, subject: string, text: string) => Promise<unknown>; now?: () => Date }
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }

  settings(tenantId: string) {
    return this.store.settings(tenantId);
  }

  async updateSettings(tenantId: string, p: Partial<Omit<ReportSettingsView, "shareToken" | "lastSentPeriod">>) {
    const data: Record<string, unknown> = {};
    if (p.brandName !== undefined) data.brandName = p.brandName?.trim() || null;
    if (p.logoDataUrl !== undefined) {
      if (p.logoDataUrl && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.logoDataUrl)) throw new ValidationError("The logo must be a PNG, JPG or WebP image.");
      if (p.logoDataUrl && p.logoDataUrl.length > REPORT_LIMITS.logoMaxChars) throw new ValidationError("The logo is too large — use a smaller image.");
      data.logoDataUrl = p.logoDataUrl || null;
    }
    if (p.accentColor !== undefined) {
      if (p.accentColor && !/^#[0-9a-fA-F]{6}$/.test(p.accentColor)) throw new ValidationError("Pick a color like #2563eb.");
      data.accentColor = p.accentColor || null;
    }
    if (p.hidePlatformName !== undefined) data.hidePlatformName = p.hidePlatformName;
    if (p.recipients !== undefined) {
      const list = [...new Set(p.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
      if (list.length > REPORT_LIMITS.maxRecipients) throw new ValidationError(`Up to ${REPORT_LIMITS.maxRecipients} emails.`);
      const bad = list.find((r) => !isValidEmail(r));
      if (bad) throw new ValidationError(`This email isn't valid: ${bad}`);
      data.recipients = list;
    }
    if (p.monthlyEmail !== undefined) data.monthlyEmail = p.monthlyEmail;
    await this.store.updateSettings(tenantId, data);
    return this.store.settings(tenantId);
  }

  // لينك جديد (القديم يبطل)
  async rotateShareLink(tenantId: string) {
    await this.store.rotate(tenantId);
    return this.store.settings(tenantId);
  }

  reportUrl(token: string, month: string) {
    return `${this.opts.frontendBaseUrl()}/report/${token}?month=${month}`;
  }

  async report(tenantId: string, month: string) {
    const range = monthRange(month);
    if (!range) throw new ValidationError("Choose a month like 2026-11.");
    const prev = monthRange(previousMonth(range.from))!;
    const [settings, rows] = await Promise.all([this.store.settings(tenantId), this.store.rows(tenantId, range, prev)]);
    if (!rows.company) throw new NotFoundError("Company not found");
    return {
      month,
      brand: { name: settings.brandName || rows.company, logoDataUrl: settings.logoDataUrl, accentColor: settings.accentColor, hidePlatformName: settings.hidePlatformName },
      company: rows.company,
      accounts: rows.accounts,
      generatedAt: this.now(),
      ...buildReport(rows),
    };
  }

  // اللينك العام (من غير دخول)
  async publicReport(token: string, month: string) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new NotFoundError("This report link isn't valid anymore.");
    const tenantId = await this.store.tenantByToken(token);
    if (!tenantId) throw new NotFoundError("This report link isn't valid anymore.");
    return this.report(tenantId, month);
  }

  // أول كل شهر: إيميل بلينك تقرير الشهر اللي فات لكل اللي مكتوبين (مرة واحدة للشهر)
  async sendMonthly(limit = 50) {
    const period = previousMonth(this.now());
    const due = await this.store.dueMonthly(period, limit);
    let sent = 0;
    for (const s of due) {
      if (!(await this.store.claimMonthly(s.tenantId, period))) continue;
      const brand = s.brand;
      const url = this.reportUrl(s.shareToken, period);
      for (const to of s.recipients) {
        await this.opts.sendEmail(to, `${brand} — social media report for ${period}`, `Hello,\n\nYour social media report for ${period} is ready:\n${url}\n\nOpen it to see posts, comments, messages and ads for the month. You can save it as a PDF from your browser (Print → Save as PDF).\n\n${brand}`).catch(() => {});
      }
      sent++;
    }
    return { period, sent };
  }
}
