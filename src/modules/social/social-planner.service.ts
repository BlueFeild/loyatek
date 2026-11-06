import crypto from "crypto";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { isValidEmail } from "../../utils/email";
import type { PlannerStore } from "./social-planner.repository";
import { SOCIAL_LIMITS } from "./social-types";

export type RepeatEvery = "DAILY" | "WEEKLY" | "MONTHLY";

// الميعاد اللي بعده للبوست المتكرر (الشهري: نفس اليوم في الشهر الجاي، ولو الشهر أقصر = آخر يوم فيه)
export function nextOccurrence(from: Date, every: RepeatEvery): Date {
  if (every === "DAILY") return new Date(from.getTime() + 86400000);
  if (every === "WEEKLY") return new Date(from.getTime() + 7 * 86400000);
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const hashApprovalToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export interface PlannerOptions {
  frontendBaseUrl: () => string;
  publicMediaUrl: (key: string) => string;
  sendEmail?: (to: string, subject: string, text: string) => Promise<unknown>;
  now?: () => Date;
}

// الكالندر (نقل البوست)، نسخ البوست، البوستات المتكررة، وموافقة العميل قبل النشر
export class SocialPlannerService {
  private readonly now: () => Date;

  constructor(
    private readonly store: PlannerStore,
    private readonly opts: PlannerOptions
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- الكالندر ----------
  async reschedule(tenantId: string, id: string, scheduledAt: Date) {
    const post = await this.store.post(tenantId, id);
    if (!post) throw new NotFoundError("Post not found");
    const now = this.now();
    // المسودة ممكن تتحط في أي يوم (تاريخ مخطط)، المجدول لازم يبقى في المستقبل
    if (post.status !== "DRAFT" && scheduledAt.getTime() < now.getTime() - 60_000) throw new ValidationError("You can't move a post to a time that already passed.");
    if (scheduledAt.getTime() > now.getTime() + SOCIAL_LIMITS.scheduleMaxDays * 86400000) throw new ValidationError(`You can schedule up to ${SOCIAL_LIMITS.scheduleMaxDays} days ahead.`);
    if (!(await this.store.reschedule(tenantId, id, scheduledAt))) throw new AppError(409, "POST_LOCKED", "This post is already published or being published — it can't be moved.");
    return { ok: true };
  }

  async duplicate(tenantId: string, id: string, userId: string | null) {
    const p = await this.store.post(tenantId, id);
    if (!p) throw new NotFoundError("Post not found");
    const copyId = await this.store.copy({
      tenantId,
      createdById: userId,
      caption: p.caption,
      mediaId: p.mediaId,
      status: "DRAFT",
      scheduledAt: null,
      options: p.options,
      repeatEvery: null,
      repeatUntil: null,
      seriesId: null,
      approvalStatus: null,
      accountIds: p.accountIds,
    });
    return { id: copyId };
  }

  // ---------- التكرار ----------
  // بيتنادى بعد ما البوست يخلص نشر (حتى لو فشل - السلسلة تكمّل): لو متكرر نعمل اللي بعده (مرة واحدة بس)
  async afterPublish(post: { id: string; tenantId: string; status: string }) {
    const p = await this.store.post(post.tenantId, post.id);
    if (!p?.repeatEvery || !p.scheduledAt) return null;
    const every = p.repeatEvery as RepeatEvery;
    const now = this.now();
    let next = nextOccurrence(p.scheduledAt, every);
    // السيرفر كان واقف كذا يوم: مانبعتش البوستات القديمة كلها مرة واحدة
    for (let i = 0; next.getTime() <= now.getTime() && i < 400; i++) next = nextOccurrence(next, every);
    if (p.repeatUntil && next.getTime() > p.repeatUntil.getTime()) return null;
    const seriesId = p.seriesId ?? p.id;
    if (await this.store.occurrenceExists(seriesId, next)) return null;
    return this.store.copy({
      tenantId: p.tenantId,
      createdById: p.createdById,
      caption: p.caption,
      mediaId: p.mediaId,
      status: "SCHEDULED",
      scheduledAt: next,
      options: p.options,
      repeatEvery: p.repeatEvery,
      repeatUntil: p.repeatUntil,
      seriesId,
      // العميل وافق على البوست المتكرر = موافق على تكراراته
      approvalStatus: p.approvalStatus === "APPROVED" ? "APPROVED" : p.approvalStatus ? "PENDING" : null,
      accountIds: p.accountIds,
    });
  }

  // ---------- موافقة العميل ----------
  // لينك جديد كل مرة (القديم بيبطل). email = نبعته للعميل كمان
  async requestApproval(tenantId: string, id: string, email?: string) {
    const post = await this.store.post(tenantId, id);
    if (!post) throw new NotFoundError("Post not found");
    const token = crypto.randomBytes(24).toString("hex");
    if (!(await this.store.setApproval(tenantId, id, { status: "PENDING", tokenHash: hashApprovalToken(token), note: null, by: null, at: null }))) {
      throw new AppError(409, "POST_LOCKED", "This post is already published — there is nothing to approve.");
    }
    const url = `${this.opts.frontendBaseUrl()}/approve/${token}`;
    let emailed = false;
    if (email && isValidEmail(email) && this.opts.sendEmail) {
      await this.opts.sendEmail(email, "A post is waiting for your approval", `Hello,\n\nA new post is ready for your review before it goes live.\n\nOpen this link to approve it or ask for changes:\n${url}\n\nThank you.`);
      emailed = true;
    }
    return { url, emailed };
  }

  async cancelApproval(tenantId: string, id: string) {
    if (!(await this.store.setApproval(tenantId, id, { status: null, tokenHash: null, note: null, by: null, at: null }))) {
      throw new AppError(409, "POST_LOCKED", "This post is already published.");
    }
    return { ok: true };
  }

  // صفحة العميل (من غير دخول)
  async approvalPage(token: string) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new NotFoundError("This approval link isn't valid anymore.");
    const p = await this.store.approvalByToken(hashApprovalToken(token));
    if (!p) throw new NotFoundError("This approval link isn't valid anymore.");
    return {
      business: p.business,
      caption: p.caption,
      status: p.status,
      scheduledAt: p.scheduledAt,
      approvalStatus: p.approvalStatus,
      approvalNote: p.approvalNote,
      approvalBy: p.approvalBy,
      approvalAt: p.approvalAt,
      media: p.media ? { kind: p.media.kind, url: this.opts.publicMediaUrl(p.media.publicKey) } : null,
      targets: p.targets,
      canDecide: ["DRAFT", "SCHEDULED", "FAILED"].includes(p.status) && p.approvalStatus !== null,
    };
  }

  async decide(token: string, d: { decision: "approve" | "changes"; name?: string; note?: string }) {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new NotFoundError("This approval link isn't valid anymore.");
    if (d.decision === "changes" && !d.note?.trim()) throw new ValidationError("Write what should be changed.");
    const ok = await this.store.decide(hashApprovalToken(token), {
      status: d.decision === "approve" ? "APPROVED" : "CHANGES",
      note: d.note?.trim() || null,
      by: d.name?.trim() || null,
      at: this.now(),
    });
    if (!ok) throw new AppError(409, "APPROVAL_CLOSED", "This post was already published or the link was replaced.");
    return this.approvalPage(token);
  }
}
