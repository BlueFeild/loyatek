import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import type { CampaignForSend, CampaignStore, CampaignTemplate, MetaConnection } from "./campaign.repository";
import type { CampaignGateway, SendResult } from "./campaign-gateway";
import { buildSendComponents, renderTemplatePreview, templateVarCount } from "./rich-templates";

export const CAMPAIGN_LIMITS = {
  concurrency: 5, // كام رسالة في نفس الوقت (Meta بتحدد معدل الإرسال)
  progressEvery: 10, // نحدّث العدّاد في قاعدة البيانات كل كام رسالة
  staleAfterMs: 15 * 60_000, // حملة SENDING من غير أي تقدم المدة دي ← FAILED (تتبعت تاني)
  minScheduleAheadMs: 60_000, // الجدولة لازم تكون بعد دقيقة على الأقل
  maxScheduleAheadMs: 90 * 24 * 3600_000, // ولحد 90 يوم
  dueBatch: 20, // كام حملة مجدولة نبدأها في كل لفّة
};

type Recipient = { phone: string; name: string };

// كل اللي اتجهّز قبل الإرسال (نفس الفحوصات للإرسال دلوقتي وللجدولة)
type Checked = { conn: MetaConnection; campaign: CampaignForSend; tpl: CampaignTemplate | null; vars: number; recipients: Recipient[]; skipped: number };

// خطة الإرسال بعد التحضير: إزاي نبعت لكل مستلم
type Plan =
  | { kind: "VOICE"; mediaId: string }
  | { kind: "TEXT"; tpl: CampaignTemplate | null; vars: number; mediaIds: string[] };

// إرسال حملة واتساب: كل الفحوصات الأول (رد 400 واضح) ← قفل ذرّي (طلب تاني = 409) ←
// تحضير الصور/الصوت مرة واحدة ← رد 202 على طول ← الإرسال في الخلفية (5 في نفس الوقت)
// والعدّاد بيتحدث كل شوية، والحالة النهائية SENT (أو FAILED لو كله فشل)
export class CampaignSender {
  private readonly running = new Map<string, Promise<void>>();
  private readonly limits: typeof CAMPAIGN_LIMITS;

  constructor(
    private readonly store: CampaignStore,
    private readonly gateway: CampaignGateway,
    limits: Partial<typeof CAMPAIGN_LIMITS> = {}
  ) {
    this.limits = { ...CAMPAIGN_LIMITS, ...limits };
  }

  async start(tenantId: string, campaignId: string) {
    const { conn, campaign, tpl, vars, recipients, skipped } = await this.check(tenantId, campaignId);

    if (!(await this.store.claim(tenantId, campaign.id))) {
      throw new AppError(409, "CAMPAIGN_BUSY", "This campaign is already being sent or was already sent. Upload a new recipient list to send it again.");
    }
    let plan: Plan;
    try {
      plan = await this.prepare(conn, campaign, tpl, vars);
    } catch (err) {
      await this.store.release(campaign.id, campaign.status).catch(() => {});
      throw err;
    }

    const work = this.deliver(conn, { ...campaign, recipients }, plan, skipped)
      .catch((err) => console.error(`[whatsapp] campaign ${campaign.id} crashed:`, err))
      .finally(() => this.running.delete(campaign.id));
    this.running.set(campaign.id, work);
    return { ok: true as const, status: "SENDING" as const, total: recipients.length, skipped };
  }

  // جدولة: نفس فحوصات الإرسال دلوقتي (عشان التاجر يعرف المشكلة قبل الميعاد مش بعده)
  async schedule(tenantId: string, campaignId: string, at: Date, now = new Date()) {
    const ahead = at.getTime() - now.getTime();
    if (!Number.isFinite(ahead) || ahead < this.limits.minScheduleAheadMs) throw new ValidationError("Pick a time at least 1 minute from now.");
    if (ahead > this.limits.maxScheduleAheadMs) throw new ValidationError("Campaigns can be scheduled up to 90 days ahead.");
    const { recipients, skipped } = await this.check(tenantId, campaignId);
    if (!(await this.store.schedule(tenantId, campaignId, at))) {
      throw new AppError(409, "CAMPAIGN_BUSY", "This campaign is being sent or was already sent — it can't be scheduled.");
    }
    return { ok: true as const, status: "SCHEDULED" as const, scheduledAt: at.toISOString(), total: recipients.length, skipped };
  }

  async unschedule(tenantId: string, campaignId: string) {
    if (!(await this.store.unschedule(tenantId, campaignId))) throw new AppError(409, "NOT_SCHEDULED", "This campaign isn't scheduled (it may already be sending).");
    return { ok: true as const, status: "DRAFT" as const };
  }

  // كل دقيقة (jobs/campaign-scheduler.ts): الحملات اللي جه ميعادها تبدأ. لو فشلت (القالب اترفض،
  // الربط اتشال، كل الناس ألغت الاشتراك) ← FAILED والسبب يبان للتاجر
  async runDue(now = new Date()) {
    const due = await this.store.dueScheduled(now, this.limits.dueBatch);
    let started = 0;
    let failed = 0;
    for (const d of due) {
      try {
        await this.start(d.tenantId, d.id);
        started++;
      } catch (err) {
        if (err instanceof AppError && err.code === "CAMPAIGN_BUSY") continue; // حد بدأها في نفس اللحظة
        failed++;
        await this.store.markFailed(d.id, err instanceof Error ? err.message : "Couldn't start the scheduled campaign");
      }
    }
    return { started, failed };
  }

  // الفحوصات + الجمهور النهائي (من غير اللي ألغوا الاشتراك ومن غير تكرار)
  private async check(tenantId: string, campaignId: string): Promise<Checked> {
    const conn = await this.store.connection(tenantId);
    if (!conn) throw new ValidationError("Connect a real Meta WhatsApp Business API account in Settings before sending campaigns.");
    const campaign = await this.store.findForSend(tenantId, campaignId);
    if (!campaign) throw new NotFoundError("Campaign not found");
    const fromBook = campaign.audienceTags.length > 0;
    const listed = fromBook ? await this.store.audience(tenantId, campaign.audienceTags, campaign.audienceMatch) : campaign.recipients;
    if (listed.length === 0) {
      throw new ValidationError(fromBook ? "No subscribed contacts have these tags yet — add contacts or pick other tags." : "Upload a recipient list (Excel file) or pick contact tags before sending this campaign.");
    }
    const unique = new Map<string, Recipient>();
    for (const r of listed) if (r.phone && !unique.has(r.phone)) unique.set(r.phone, r);
    const optedOut = await this.store.optedOutAmong(tenantId, [...unique.keys()]);
    const recipients = [...unique.values()].filter((r) => !optedOut.has(r.phone));
    const skipped = listed.length - recipients.length;
    if (recipients.length === 0) throw new ValidationError("Everyone on this list has unsubscribed (replied STOP) — there's nobody left to send to.");
    if (campaign.kind === "VOICE" && !campaign.audioBase64) throw new ValidationError("This voice campaign has no recording attached.");
    const tpl = campaign.kind === "TEXT" ? await this.approvedTemplate(conn, campaign) : null;
    const vars = tpl ? templateVarCount(tpl.bodyText) : 0;
    // {{1}} بيتملا باسم العميل - أكتر من فراغ واحد مش مدعوم في الحملات
    if (vars > 1) throw new ValidationError(`This template has ${vars} blanks — campaigns can fill only {{1}} (the customer's name). Use a template with at most one blank.`);
    return { conn, campaign, tpl, vars, recipients, skipped };
  }

  // قبل عرض الحملات: اللي علّقت (السيرفر اتعاد تشغيله وهي بتتبعت) ← FAILED
  expireStale(tenantId: string) {
    return this.store.expireStale(tenantId, new Date(Date.now() - this.limits.staleAfterMs), [...this.running.keys()]);
  }

  // للاختبارات: نستنى كل الحملات اللي بتتبعت تخلص
  async whenIdle() {
    await Promise.all([...this.running.values()]);
  }

  // قالب الحملة لازم يكون معتمد. لو لسه PENDING عندنا نسأل Meta الأول (يمكن اتوافق عليه)
  private async approvedTemplate(conn: MetaConnection, campaign: CampaignForSend): Promise<CampaignTemplate | null> {
    let tpl = campaign.template;
    if (!tpl) return null; // من غير قالب ← hello_world
    if (tpl.status === "PENDING" && tpl.metaTemplateId) {
      const check = await this.gateway.templateStatus(conn, tpl.metaTemplateId);
      if (check.ok && (check.status === "APPROVED" || check.status === "REJECTED")) {
        tpl = await this.store.setTemplateStatus(tpl.id, check.status, check.rejectionReason ?? null);
      }
    }
    if (tpl.status !== "APPROVED") {
      throw new ValidationError(`This campaign's template "${tpl.name}" isn't approved by Meta yet (status: ${tpl.status}). Wait for approval or send without a custom template.`);
    }
    return tpl;
  }

  // الصوت / الصور بيترفعوا لـ Meta مرة واحدة للحملة كلها، ونفس الـ id بيتبعت لكل المستلمين
  private async prepare(conn: MetaConnection, campaign: CampaignForSend, tpl: CampaignTemplate | null, vars: number): Promise<Plan> {
    if (campaign.kind === "VOICE") {
      const up = await this.gateway.uploadAudio(conn, campaign.audioBase64!);
      if (!up.ok || !up.mediaId) throw new ValidationError(up.error || "Failed to upload the voice recording to Meta");
      return { kind: "VOICE", mediaId: up.mediaId };
    }
    let mediaIds: string[] = [];
    if (tpl) {
      const up = await this.gateway.uploadTemplateImages(conn, tpl);
      if (!up.ok) throw new ValidationError(`Couldn't prepare the template images: ${up.error}`);
      mediaIds = up.mediaIds;
    }
    return { kind: "TEXT", tpl, vars, mediaIds };
  }

  private async deliver(conn: MetaConnection, campaign: CampaignForSend, plan: Plan, skipped: number) {
    let sent = 0;
    let failed = 0;
    let done = 0;
    // تحديثات العدّاد ورا بعض (عشان رقم قديم مايكتبش فوق رقم أحدث)
    let saving: Promise<void> = Promise.resolve();
    const saveProgress = () => {
      saving = saving.then(() => this.store.progress(campaign.id, sent, failed)).catch((e) => console.error(`[whatsapp] campaign ${campaign.id} progress:`, e));
    };

    try {
      await runPool(campaign.recipients, this.limits.concurrency, async (r) => {
        let ok = false;
        try {
          ok = await this.sendOne(conn, campaign.tenantId, campaign.id, r, plan);
        } catch (err) {
          console.error(`[whatsapp] campaign ${campaign.id} → ${r.phone}:`, err);
        }
        if (ok) sent++;
        else failed++;
        if (++done % this.limits.progressEvery === 0) saveProgress();
      });
    } finally {
      await saving;
      await this.store.finish(campaign.id, sent === 0 && failed > 0 ? "FAILED" : "SENT", sent, failed, skipped);
    }
  }

  private async sendOne(conn: MetaConnection, tenantId: string, campaignId: string, r: Recipient, plan: Plan): Promise<boolean> {
    if (plan.kind === "VOICE") {
      // واتساب مايسمحش بصوت حر إلا للي كلّم الحساب في آخر 24 ساعة - متوقع إن بعضهم يفشل
      return (await this.gateway.sendAudio(conn, r.phone, plan.mediaId)).ok;
    }
    const { tpl, vars, mediaIds } = plan;
    const params = vars === 1 ? [String(r.name || "").trim() || "there"] : [];
    const result: SendResult = tpl
      ? await this.gateway.sendTemplate(conn, r.phone, tpl.name, tpl.language, buildSendComponents(tpl, mediaIds, params))
      : await this.gateway.sendHelloWorld(conn, r.phone);
    // الرسالة بتظهر في Team Inbox كمان (عشان ردود العملاء تبان جنبها)
    await this.store.recordOutgoing({
      tenantId,
      contactPhone: r.phone,
      contactName: r.name || null,
      body: tpl ? renderTemplatePreview(tpl, params) : "hello_world (Meta test template)",
      waMessageId: result.ok ? result.messageId ?? null : null,
      ok: result.ok,
      error: result.ok ? null : result.error ?? null,
      campaignId,
    });
    return result.ok;
  }
}

// تشغيل fn على كل العناصر، بحد أقصى limit في نفس الوقت
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
