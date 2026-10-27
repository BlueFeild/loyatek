import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import type { CampaignForSend, CampaignStore, CampaignTemplate, MetaConnection } from "./campaign.repository";
import type { CampaignGateway, SendResult } from "./campaign-gateway";
import { buildSendComponents, renderTemplatePreview, templateVarCount } from "./rich-templates";

export const CAMPAIGN_LIMITS = {
  concurrency: 5, // كام رسالة في نفس الوقت (Meta بتحدد معدل الإرسال)
  progressEvery: 10, // نحدّث العدّاد في قاعدة البيانات كل كام رسالة
  staleAfterMs: 15 * 60_000, // حملة SENDING من غير أي تقدم المدة دي ← FAILED (تتبعت تاني)
};

type Recipient = { phone: string; name: string };

// خطة الإرسال بعد التحضير: إزاي نبعت لكل مستلم
type Plan =
  | { kind: "VOICE"; mediaId: string }
  | { kind: "TEXT"; tpl: CampaignTemplate | null; vars: number; mediaIds: string[] };

// إرسال حملة واتساب: كل الفحوصات الأول (رد 400 واضح) ← قفل ذرّي (طلب تاني = 409) ←
// تحضير الصور/الصوت مرة واحدة ← رد 202 على طول ← الإرسال في الخلفية (5 في نفس الوقت)
// والعدّاد بيتحدث كل شوية، والحالة النهائية SENT (أو FAILED لو كله فشل)
export class CampaignSender {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly store: CampaignStore,
    private readonly gateway: CampaignGateway,
    private readonly limits = CAMPAIGN_LIMITS
  ) {}

  async start(tenantId: string, campaignId: string) {
    const conn = await this.store.connection(tenantId);
    if (!conn) throw new ValidationError("Connect a real Meta WhatsApp Business API account in Settings before sending campaigns.");
    const campaign = await this.store.findForSend(tenantId, campaignId);
    if (!campaign) throw new NotFoundError("Campaign not found");
    if (campaign.recipients.length === 0) throw new ValidationError("Upload a recipient list (Excel file) before sending this campaign.");
    if (campaign.kind === "VOICE" && !campaign.audioBase64) throw new ValidationError("This voice campaign has no recording attached.");
    const tpl = campaign.kind === "TEXT" ? await this.approvedTemplate(conn, campaign) : null;
    const vars = tpl ? templateVarCount(tpl.bodyText) : 0;
    // {{1}} بيتملا باسم العميل من ملف الإكسل - أكتر من فراغ واحد مش مدعوم في الحملات
    if (vars > 1) throw new ValidationError(`This template has ${vars} blanks — campaigns can fill only {{1}} (the customer's name). Use a template with at most one blank.`);

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

    const work = this.deliver(conn, campaign, plan)
      .catch((err) => console.error(`[whatsapp] campaign ${campaign.id} crashed:`, err))
      .finally(() => this.running.delete(campaign.id));
    this.running.set(campaign.id, work);
    return { ok: true as const, status: "SENDING" as const, total: campaign.recipients.length };
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

  private async deliver(conn: MetaConnection, campaign: CampaignForSend, plan: Plan) {
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
          ok = await this.sendOne(conn, campaign.tenantId, r, plan);
        } catch (err) {
          console.error(`[whatsapp] campaign ${campaign.id} → ${r.phone}:`, err);
        }
        if (ok) sent++;
        else failed++;
        if (++done % this.limits.progressEvery === 0) saveProgress();
      });
    } finally {
      await saving;
      await this.store.finish(campaign.id, sent === 0 && failed > 0 ? "FAILED" : "SENT", sent, failed);
    }
  }

  private async sendOne(conn: MetaConnection, tenantId: string, r: Recipient, plan: Plan): Promise<boolean> {
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
