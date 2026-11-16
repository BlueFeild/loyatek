import { randomUUID } from "crypto";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import type { CampaignInput, CampaignRow, CampaignStatus, SmsStore } from "./sms.repository";
import type { SmsProvider } from "./sms-provider";
import { countSegments, normalizePhone, parsePastedList, renderSmsBody, SENDER_NAME_RE, SMS_BODY_MAX, type Recipient } from "./sms-text";

export const SMS_LIMITS = {
  concurrency: 5, // كام رسالة في نفس الوقت
  progressEvery: 10, // نحدّث العدّاد كل كام رسالة
  staleAfterMs: 15 * 60_000, // حملة SENDING واقفة المدة دي (السيرفر اتقفل) ← FAILED + استرجاع الباقي
  minScheduleAheadMs: 60_000,
  maxScheduleAheadMs: 90 * 24 * 3600_000,
  dueBatch: 20,
};

export function notConfigured() {
  return new AppError(503, "SMS_NOT_CONFIGURED", "SMS isn't switched on yet. Nothing was charged.");
}

function insufficient(required: number, balance: number) {
  const err = new AppError(402, "INSUFFICIENT_SMS_BALANCE", `Not enough SMS balance — this needs ${required} SMS, you have ${balance}.`);
  err.details = { required, balance };
  return err;
}

// تجهيز جمهور الحملة: الأرقام النهائية + كام واحد اتشال (ألغى الاشتراك / اتبعتله قبل كده)
interface Audience {
  recipients: (Recipient & { body: string; segments: number })[];
  skippedOptedOut: number;
  alreadySent: number;
  totalSegments: number;
}

// خدمة الـ SMS: الرصيد (خصم قبل الإرسال واسترجاع لو فشل)، رسالة واحدة، حملات (دلوقتي/مجدولة)
export class SmsService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly limits: typeof SMS_LIMITS;

  constructor(
    private readonly store: SmsStore,
    private readonly provider: () => SmsProvider | null,
    limits: Partial<typeof SMS_LIMITS> = {}
  ) {
    this.limits = { ...SMS_LIMITS, ...limits };
  }

  providerReady() {
    return this.provider() !== null;
  }

  // ---------- الرصيد والإعدادات ----------
  async overview(tenantId: string, now = new Date()) {
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [account, usage, last] = await Promise.all([
      this.store.account(tenantId),
      this.store.monthUsage(tenantId, since),
      this.store.listMessages(tenantId, { page: 1, pageSize: 5 }),
    ]);
    return { ...account, providerReady: this.providerReady(), sentThisMonth: usage, lastMessages: last.items };
  }

  async settings(tenantId: string) {
    const [account, transactions] = await Promise.all([this.store.account(tenantId), this.store.transactions(tenantId, 50)]);
    return { ...account, providerReady: this.providerReady(), transactions };
  }

  async updateSender(tenantId: string, senderName: string | null) {
    const v = senderName?.trim() || null;
    if (v && !SENDER_NAME_RE.test(v)) throw new ValidationError("Sender name: 3–11 English letters or digits, starting with a letter (no spaces).");
    await this.store.setSenderName(tenantId, v);
    return this.settings(tenantId);
  }

  // ---------- رسالة واحدة ----------
  async sendOne(tenantId: string, userId: string | null, rawTo: string, rawBody: string) {
    const provider = this.provider();
    if (!provider) throw notConfigured();
    const to = normalizePhone(rawTo);
    if (!to) throw new ValidationError("Please enter the phone number with its country code (for example +974 5555 1234).");
    const body = String(rawBody ?? "").trim();
    if (!body) throw new ValidationError("Please write the message.");
    if (body.length > SMS_BODY_MAX) throw new ValidationError(`The message is too long (max ${SMS_BODY_MAX} characters).`);
    const { segments } = countSegments(body);

    const id = randomUUID();
    if (!(await this.store.spend(tenantId, segments, { reason: "SEND", refId: id, userId, note: "Single SMS" }))) {
      throw insufficient(segments, (await this.store.account(tenantId)).balance);
    }
    const account = await this.store.account(tenantId);
    await this.store.createMessage({ id, tenantId, to, body, segments, status: "QUEUED", provider: provider.name });
    const result = await provider.send({ to, body, sender: account.senderName }).catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) }) as const);
    if (result.ok) {
      await this.store.updateMessage(id, { status: "SENT", providerId: result.providerId ?? null });
      return { ok: true as const, id, segments, balance: (await this.store.account(tenantId)).balance };
    }
    await this.store.updateMessage(id, { status: "FAILED", error: result.error ?? "Unknown error" });
    await this.store.adjust(tenantId, segments, { reason: "REFUND", refId: id, note: "SMS failed" });
    const err = new AppError(502, "SMS_SEND_FAILED", `The SMS couldn't be sent (${result.error ?? "provider error"}). Your balance was not charged.`);
    err.details = { id };
    throw err;
  }

  messages(tenantId: string, q: { status?: string; campaignId?: string; page: number; pageSize: number }) {
    return this.store.listMessages(tenantId, q);
  }

  // ---------- الحملات ----------
  async audience(tenantId: string) {
    return this.store.tagCounts(tenantId);
  }

  listCampaigns(tenantId: string) {
    return this.store.listCampaigns(tenantId).then((rows) => rows.map((c) => this.view(c)));
  }

  async getCampaign(tenantId: string, id: string) {
    return this.view(await this.mustGet(tenantId, id), true);
  }

  // pasted = نص ملصوق ("رقم,اسم" في كل سطر). لو اتبعت، التاجات بتتمسح (والعكس)
  async createCampaign(tenantId: string, input: { name: string; body: string; audienceTags?: string[]; audienceMatch?: "any" | "all"; pasted?: string | null }) {
    const { data, paste } = this.prepareInput(input);
    const row = await this.store.createCampaign(tenantId, {
      name: data.name!,
      body: data.body!,
      audienceTags: data.audienceTags ?? [],
      audienceMatch: data.audienceMatch ?? "any",
      recipients: data.recipients ?? null,
    });
    return { campaign: this.view(row, true), paste };
  }

  async updateCampaign(tenantId: string, id: string, input: { name?: string; body?: string; audienceTags?: string[]; audienceMatch?: "any" | "all"; pasted?: string | null }) {
    const current = await this.mustGet(tenantId, id);
    if (current.status !== "DRAFT") throw new AppError(409, "CAMPAIGN_LOCKED", "Only draft campaigns can be edited.");
    const { data, paste } = this.prepareInput(input);
    if (!(await this.store.updateDraft(tenantId, id, data))) throw new AppError(409, "CAMPAIGN_LOCKED", "Only draft campaigns can be edited.");
    return { campaign: this.view((await this.store.getCampaign(tenantId, id))!, true), paste };
  }

  async deleteCampaign(tenantId: string, id: string) {
    await this.mustGet(tenantId, id);
    if (!(await this.store.deleteDraft(tenantId, id))) throw new AppError(409, "CAMPAIGN_LOCKED", "Only draft campaigns can be deleted.");
    return { ok: true as const };
  }

  async estimate(tenantId: string, id: string) {
    const c = await this.mustGet(tenantId, id);
    const [aud, account] = await Promise.all([this.resolveAudience(c), this.store.account(tenantId)]);
    const enough = account.unlimited || account.balance >= aud.totalSegments;
    return {
      recipients: aud.recipients.length,
      skippedOptedOut: aud.skippedOptedOut,
      alreadySent: aud.alreadySent,
      totalSegments: aud.totalSegments,
      segmentsEach: aud.recipients.length ? Math.max(...aud.recipients.map((r) => r.segments)) : countSegments(c.body).segments,
      balance: account.balance,
      unlimited: account.unlimited,
      enough,
      balanceAfter: account.unlimited ? account.balance : account.balance - aud.totalSegments,
      providerReady: this.providerReady(),
    };
  }

  // إرسال دلوقتي: الفحوصات → قفل ذرّي (طلب تاني = 409) → حجز التكلفة كلها → رد على طول
  // والإرسال في الخلفية 5 في نفس الوقت، والرسايل اللي فشلت فلوسها بترجع في الآخر
  async start(tenantId: string, id: string, userId: string | null = null, from: CampaignStatus[] = ["DRAFT", "FAILED"]) {
    const provider = this.provider();
    if (!provider) throw notConfigured();
    const c = { ...(await this.mustGet(tenantId, id)) }; // نسخة: الحالة قبل القفل
    if (!(await this.store.claim(tenantId, id, from))) {
      throw new AppError(409, "CAMPAIGN_BUSY", "This campaign is already being sent or was already sent.");
    }
    const back: CampaignStatus = c.status === "SCHEDULED" ? "FAILED" : (c.status as CampaignStatus);
    let aud: Audience;
    try {
      aud = await this.resolveAudience(c);
      if (aud.recipients.length === 0) throw new AppError(400, "NO_RECIPIENTS", "Nobody to send to — choose tags with contacts or paste some numbers.");
      if (!(await this.store.spend(tenantId, aud.totalSegments, { reason: "SEND", refId: c.id, userId, note: `Campaign: ${c.name.slice(0, 60)}` }))) {
        throw insufficient(aud.totalSegments, (await this.store.account(tenantId)).balance);
      }
    } catch (err) {
      await this.store.release(c.id, back, c.status === "SCHEDULED" ? (err as Error).message : c.lastError).catch(() => {});
      throw err;
    }
    await this.store.startSending(c.id, { total: aud.recipients.length, segmentsUsed: aud.totalSegments });
    const sender = (await this.store.account(tenantId)).senderName;
    const work = this.deliver(c, aud, provider, sender)
      .catch((err) => console.error(`[sms] campaign ${c.id} crashed: ${(err as Error)?.message}`))
      .finally(() => this.running.delete(c.id));
    this.running.set(c.id, work);
    return { ok: true as const, status: "SENDING" as const, total: aud.recipients.length, totalSegments: aud.totalSegments, skippedOptedOut: aud.skippedOptedOut };
  }

  // للتجارب: نستنى الحملة تخلص
  async waitFor(id: string) {
    await this.running.get(id);
  }

  async schedule(tenantId: string, id: string, at: Date, now = new Date()) {
    const ahead = at.getTime() - now.getTime();
    if (!Number.isFinite(ahead) || ahead < this.limits.minScheduleAheadMs) throw new ValidationError("Pick a time at least 1 minute from now.");
    if (ahead > this.limits.maxScheduleAheadMs) throw new ValidationError("Campaigns can be scheduled up to 90 days ahead.");
    const c = await this.mustGet(tenantId, id);
    const aud = await this.resolveAudience(c);
    if (aud.recipients.length === 0) throw new AppError(400, "NO_RECIPIENTS", "Nobody to send to — choose tags with contacts or paste some numbers.");
    if (!(await this.store.schedule(tenantId, id, at))) throw new AppError(409, "CAMPAIGN_BUSY", "This campaign is being sent or was already sent — it can't be scheduled.");
    return { ok: true as const, status: "SCHEDULED" as const, scheduledAt: at.toISOString(), total: aud.recipients.length };
  }

  async unschedule(tenantId: string, id: string) {
    await this.mustGet(tenantId, id);
    if (!(await this.store.unschedule(tenantId, id))) throw new AppError(409, "NOT_SCHEDULED", "This campaign isn't scheduled (it may already be sending).");
    return { ok: true as const, status: "DRAFT" as const };
  }

  // كل دقيقة: الحملات اللي جه ميعادها + الحملات اللي وقفت في النص (السيرفر اتقفل)
  async runDue(now = new Date()) {
    let started = 0;
    let failed = 0;
    for (const c of await this.store.staleSending(new Date(now.getTime() - this.limits.staleAfterMs))) {
      if (this.running.has(c.id)) continue;
      const used = await this.store.sentSegmentsForCampaign(c.id);
      const refund = Math.max(0, c.segmentsUsed - used);
      if (refund > 0) await this.store.adjust(c.tenantId, refund, { reason: "REFUND", refId: c.id, note: "Campaign stopped — unsent SMS returned" });
      await this.store.finish(c.id, { status: "FAILED", sentCount: c.sentCount, failedCount: c.failedCount, segmentsUsed: used, lastError: "Sending stopped before it finished. Unsent SMS were returned to your balance — press Send again to reach the rest." });
    }
    for (const { id, tenantId } of await this.store.dueCampaigns(now, this.limits.dueBatch)) {
      try {
        await this.start(tenantId, id, null, ["SCHEDULED"]);
        started++;
      } catch (err) {
        failed++;
        console.warn(`[sms] scheduled campaign ${id} couldn't start: ${(err as AppError)?.code ?? (err as Error)?.message}`);
      }
    }
    return { started, failed };
  }

  async report(tenantId: string, id: string) {
    const c = await this.mustGet(tenantId, id);
    const messages = (await this.store.campaignMessages(tenantId, id, 5000)) as { status: string; segments: number }[];
    const sent = messages.filter((m) => m.status === "SENT" || m.status === "DELIVERED");
    return {
      campaign: this.view(c),
      sent: sent.length,
      failed: messages.filter((m) => m.status === "FAILED").length,
      queued: messages.filter((m) => m.status === "QUEUED").length,
      segments: sent.reduce((s, m) => s + m.segments, 0),
      messages,
    };
  }

  // ---------- السوبر أدمن ----------
  async adminView(tenantId: string) {
    if (!(await this.store.tenantExists(tenantId))) throw new NotFoundError("Company not found");
    const [account, transactions] = await Promise.all([this.store.account(tenantId), this.store.transactions(tenantId, 30)]);
    return { ...account, transactions };
  }

  async adminAdjust(tenantId: string, amount: number, note: string | undefined, userId: string) {
    if (!(await this.store.tenantExists(tenantId))) throw new NotFoundError("Company not found");
    const balance = await this.store.adjust(tenantId, amount, { reason: "GRANT", note: note || (amount > 0 ? "Added by BlueField" : "Removed by BlueField"), userId });
    if (balance === null) throw new ValidationError("The balance can't go below 0.");
    return { balance };
  }

  // ---------- داخلي ----------
  private async mustGet(tenantId: string, id: string) {
    const c = await this.store.getCampaign(tenantId, id);
    if (!c) throw new NotFoundError("Campaign not found");
    return c;
  }

  private prepareInput(input: { name?: string; body?: string; audienceTags?: string[]; audienceMatch?: "any" | "all"; pasted?: string | null }) {
    const data: Partial<CampaignInput> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.body !== undefined) data.body = input.body.trim();
    if (input.audienceMatch !== undefined) data.audienceMatch = input.audienceMatch;
    let paste: { added: number; invalid: { line: number; text: string }[]; duplicates: number; tooMany: boolean } | null = null;
    if (typeof input.pasted === "string") {
      const p = parsePastedList(input.pasted);
      data.recipients = p.recipients;
      data.audienceTags = [];
      paste = { added: p.recipients.length, invalid: p.invalid, duplicates: p.duplicates, tooMany: p.tooMany };
    } else if (input.audienceTags !== undefined) {
      data.audienceTags = Array.from(new Set(input.audienceTags.map((t) => t.trim().toLowerCase()).filter(Boolean))).slice(0, 30);
      if (data.audienceTags.length > 0) data.recipients = null;
    }
    return { data, paste };
  }

  private async resolveAudience(c: CampaignRow): Promise<Audience> {
    let list: Recipient[] = [];
    let skippedOptedOut = 0;
    if (c.audienceTags.length > 0) {
      const r = await this.store.audienceByTags(c.tenantId, c.audienceTags, c.audienceMatch === "all" ? "all" : "any");
      list = r.recipients;
      skippedOptedOut = r.optedOut;
    } else if (Array.isArray(c.recipients)) {
      list = c.recipients as Recipient[];
      const out = await this.store.optedOutPhones(c.tenantId, list.map((r) => r.phone));
      skippedOptedOut = list.filter((r) => out.has(r.phone)).length;
      list = list.filter((r) => !out.has(r.phone));
    }
    // تنظيف + بدون تكرار + (لو الحملة اتبعتت قبل كده وفشلت) من غير اللي وصلتهم خلاص
    const sent = c.status === "DRAFT" ? new Set<string>() : await this.store.sentPhonesForCampaign(c.id);
    const seen = new Set<string>();
    const recipients: Audience["recipients"] = [];
    let alreadySent = 0;
    for (const r of list) {
      const phone = normalizePhone(r.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      if (sent.has(phone)) {
        alreadySent++;
        continue;
      }
      const body = renderSmsBody(c.body, r.name ?? "");
      recipients.push({ phone, name: r.name ?? "", body, segments: Math.max(1, countSegments(body).segments) });
    }
    return { recipients, skippedOptedOut, alreadySent, totalSegments: recipients.reduce((s, r) => s + r.segments, 0) };
  }

  private async deliver(c: CampaignRow, aud: Audience, provider: SmsProvider, sender: string | null) {
    let sentCount = 0;
    let failedCount = 0;
    let failedSegments = 0;
    let lastError: string | null = null;
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < aud.recipients.length) {
        const r = aud.recipients[next++];
        let ok = false;
        try {
          const msg = await this.store.createMessage({ tenantId: c.tenantId, campaignId: c.id, to: r.phone, body: r.body, segments: r.segments, status: "QUEUED", provider: provider.name });
          const res = await provider.send({ to: r.phone, body: r.body, sender }).catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) }) as const);
          ok = res.ok;
          if (res.ok) await this.store.updateMessage(msg.id, { status: "SENT", providerId: res.providerId ?? null });
          else {
            lastError = res.error ?? "Provider error";
            await this.store.updateMessage(msg.id, { status: "FAILED", error: lastError });
          }
        } catch (err) {
          lastError = (err as Error)?.message ?? "Error";
        }
        if (ok) sentCount++;
        else {
          failedCount++;
          failedSegments += r.segments;
        }
        if (++done % this.limits.progressEvery === 0) await this.store.progress(c.id, { sentCount, failedCount }).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.concurrency, aud.recipients.length) }, worker));
    if (failedSegments > 0) await this.store.adjust(c.tenantId, failedSegments, { reason: "REFUND", refId: c.id, note: `${failedCount} campaign SMS failed` });
    const status: CampaignStatus = sentCount > 0 ? "SENT" : "FAILED";
    const err = failedCount === 0 ? null : sentCount === 0 ? `No SMS could be sent: ${lastError ?? "provider error"}` : `${failedCount} SMS failed (${lastError ?? "provider error"}). Their cost was returned.`;
    await this.store.finish(c.id, { status, sentCount, failedCount, segmentsUsed: aud.totalSegments - failedSegments, lastError: err });
    console.log(`[sms] campaign ${c.id}: ${sentCount} sent, ${failedCount} failed`);
  }

  private view(c: CampaignRow, full = false) {
    const list = Array.isArray(c.recipients) ? (c.recipients as Recipient[]) : null;
    return {
      id: c.id,
      name: c.name,
      body: c.body,
      audienceTags: c.audienceTags,
      audienceMatch: c.audienceMatch,
      audienceType: c.audienceTags.length > 0 ? "tags" : list ? "list" : "none",
      listCount: list?.length ?? 0,
      ...(full && list ? { pasted: list.map((r) => (r.name ? `+${r.phone},${r.name}` : `+${r.phone}`)).join("\n") } : {}),
      status: c.status,
      scheduledAt: c.scheduledAt,
      sentAt: c.sentAt,
      total: c.total,
      sentCount: c.sentCount,
      failedCount: c.failedCount,
      segmentsUsed: c.segmentsUsed,
      lastError: c.lastError,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
