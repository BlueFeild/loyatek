import { z } from "zod";
import { NotFoundError, ValidationError } from "../../core/errors";
import { normalizePhone, normalizeTags } from "./contact-book.service";
import { templateVarCount } from "./rich-templates";

// سلسلة رسايل واتساب (Drip / Sequence زي WATI): جهة الاتصال تاخد تاج (أو تتضاف يدوي) →
// يوصلها قالب 1، وبعد المدة قالب 2... وتقف لو العميل رد أو ألغى الاشتراك.
// المنطق هنا بس - قاعدة البيانات في sequence.repository.ts والإرسال لـ Meta في sequence.gateway.ts

export const MAX_STEPS = 10;
export const MIN_DELAY_MINUTES = 0;
export const MAX_DELAY_MINUTES = 90 * 24 * 60; // 90 يوم
// لو الإرسال فشل: محاولة تانية بعد نص ساعة، ولو فشل تاني السلسلة تقف للشخص ده
export const RETRY_AFTER_MS = 30 * 60_000;
// الصف بيتحجز (lease) وقت الإرسال عشان سيرفرين مايبعتوش نفس الرسالة
export const CLAIM_LEASE_MS = 10 * 60_000;

export interface SequenceStep {
  delayMinutes: number;
  templateId: string;
}

export interface SequenceRow {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  triggerTag: string | null;
  stopOnReply: boolean;
  steps: SequenceStep[];
  createdAt: Date;
}

export interface EnrollmentRow {
  id: string;
  tenantId: string;
  sequenceId: string;
  phone: string;
  name: string;
  stepIndex: number;
  status: string;
  enrolledAt: Date;
  lastError: string | null;
}

export interface TemplateInfo {
  id: string;
  name: string;
  status: string;
  bodyText: string;
}

export interface SequenceStore {
  list(tenantId: string): Promise<SequenceRow[]>;
  get(tenantId: string, id: string): Promise<SequenceRow | null>;
  create(tenantId: string, data: { name: string; triggerTag: string | null; stopOnReply: boolean; steps: SequenceStep[] }): Promise<SequenceRow>;
  update(tenantId: string, id: string, data: Partial<{ name: string; triggerTag: string | null; stopOnReply: boolean; steps: SequenceStep[]; enabled: boolean }>): Promise<SequenceRow>;
  remove(tenantId: string, id: string): Promise<void>;
  templates(tenantId: string, ids: string[]): Promise<TemplateInfo[]>;
  counts(tenantId: string): Promise<Map<string, Record<string, number>>>;
  people(tenantId: string, sequenceId: string, limit: number): Promise<(EnrollmentRow & { nextAt: Date | null; lastSentAt: Date | null; stopReason: string | null })[]>;
  // اللي عليهم التاج ومش مشتركين في السلسلة (مش ملغيين الاشتراك)
  taggedNotEnrolled(seq: SequenceRow, limit: number): Promise<{ phone: string; name: string }[]>;
  // بيضيف اللي مش موجودين بس (مفيش تكرار)
  enroll(seq: SequenceRow, people: { phone: string; name: string }[], status: "ACTIVE" | "SKIPPED", nextAt: Date | null): Promise<number>;
  enabledWithTag(limit: number): Promise<SequenceRow[]>;
  claimDue(now: Date, leaseUntil: Date, limit: number): Promise<EnrollmentRow[]>;
  finishStep(id: string, data: { stepIndex: number; status: string; nextAt: Date | null; lastSentAt?: Date; lastError?: string | null; stopReason?: string | null }): Promise<void>;
  stopOne(tenantId: string, sequenceId: string, enrollmentId: string): Promise<boolean>;
  contact(tenantId: string, phone: string): Promise<{ optedOut: boolean } | null>;
  repliedSince(tenantId: string, phone: string, since: Date): Promise<boolean>;
}

export interface SequenceSender {
  // {{1}} = اسم العميل
  send(tenantId: string, phone: string, name: string, templateId: string): Promise<{ ok: boolean; error?: string }>;
}

const stepSchema = z.object({
  delayMinutes: z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES, "A wait can be up to 90 days"),
  templateId: z.string().uuid("Choose a template for every message"),
});

const baseSchema = z.object({
  name: z.string().trim().min(1, "Give the series a name").max(80),
  triggerTag: z.string().trim().max(40).nullable().optional(),
  stopOnReply: z.boolean().optional(),
  steps: z.array(stepSchema).max(MAX_STEPS, `A series can have up to ${MAX_STEPS} messages`).optional(),
});

const patchSchema = baseSchema.partial().extend({
  enabled: z.boolean().optional(),
  // وقت التشغيل: اللي عليهم التاج من قبل - يبدأوا هما كمان ولا لأ
  includeExisting: z.boolean().optional(),
});

const enrollSchema = z.object({
  phones: z.array(z.object({ phone: z.string().max(30), name: z.string().max(80).optional() })).max(5000).optional(),
});

function cleanTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return normalizeTags([tag])[0] ?? null;
}

// ميعاد الرسالة رقم index: المدة بتاعتها من دلوقتي
export function nextStepAt(steps: SequenceStep[], index: number, from: Date): Date | null {
  const step = steps[index];
  return step ? new Date(from.getTime() + step.delayMinutes * 60_000) : null;
}

// قرار قبل الإرسال (منفصل عشان يتختبر)
export function decide(
  seq: Pick<SequenceRow, "enabled" | "steps" | "stopOnReply"> | null,
  enr: Pick<EnrollmentRow, "stepIndex">,
  contact: { optedOut: boolean } | null,
  replied: boolean
): { action: "send" } | { action: "stop"; reason: string } | { action: "done" } | { action: "pause" } {
  if (!seq) return { action: "stop", reason: "The series was deleted" };
  if (!seq.enabled) return { action: "pause" };
  if (enr.stepIndex >= seq.steps.length) return { action: "done" };
  if (contact?.optedOut) return { action: "stop", reason: "Unsubscribed (replied STOP)" };
  if (seq.stopOnReply && replied) return { action: "stop", reason: "Replied" };
  return { action: "send" };
}

export class SequenceService {
  constructor(
    private readonly store: SequenceStore,
    private readonly sender: SequenceSender,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(tenantId: string) {
    const [rows, counts] = await Promise.all([this.store.list(tenantId), this.store.counts(tenantId)]);
    return rows.map((r) => ({ ...r, counts: counts.get(r.id) ?? {} }));
  }

  // القوالب لازم تكون تبع الشركة، ومعتمدة لو السلسلة هتشتغل، ومفيهاش أكتر من فراغ واحد ({{1}} = الاسم)
  private async checkTemplates(tenantId: string, steps: SequenceStep[], mustBeApproved: boolean) {
    const ids = [...new Set(steps.map((s) => s.templateId))];
    const found = await this.store.templates(tenantId, ids);
    const byId = new Map(found.map((t) => [t.id, t]));
    for (const [i, s] of steps.entries()) {
      const t = byId.get(s.templateId);
      if (!t) throw new ValidationError(`Message ${i + 1}: template not found`);
      if (templateVarCount(t.bodyText) > 1) throw new ValidationError(`Message ${i + 1}: "${t.name}" has more than one blank — a series can only fill {{1}} with the customer's name`);
      if (mustBeApproved && t.status !== "APPROVED") throw new ValidationError(`Message ${i + 1}: "${t.name}" isn't approved by Meta yet`);
    }
  }

  async create(tenantId: string, body: unknown) {
    const r = baseSchema.safeParse(body);
    if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid series");
    const steps = r.data.steps ?? [];
    await this.checkTemplates(tenantId, steps, false);
    return this.store.create(tenantId, { name: r.data.name, triggerTag: cleanTag(r.data.triggerTag), stopOnReply: r.data.stopOnReply ?? true, steps });
  }

  async update(tenantId: string, id: string, body: unknown) {
    const r = patchSchema.safeParse(body);
    if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid series");
    const seq = await this.store.get(tenantId, id);
    if (!seq) throw new NotFoundError("Series not found");
    const wasEnabled = seq.enabled;
    const steps = r.data.steps ?? seq.steps;
    const enabled = r.data.enabled ?? seq.enabled;
    if (enabled && steps.length === 0) throw new ValidationError("Add at least one message before turning the series on");
    await this.checkTemplates(tenantId, steps, enabled);
    const updated = await this.store.update(tenantId, id, {
      ...(r.data.name !== undefined ? { name: r.data.name } : {}),
      ...(r.data.triggerTag !== undefined ? { triggerTag: cleanTag(r.data.triggerTag) } : {}),
      ...(r.data.stopOnReply !== undefined ? { stopOnReply: r.data.stopOnReply } : {}),
      ...(r.data.steps !== undefined ? { steps } : {}),
      enabled,
    });
    // أول تشغيل: اللي عليهم التاج من قبل - لو التاجر مش عايز يبعتلهم بنسجلهم SKIPPED عشان ماتبدأش معاهم
    if (enabled && !wasEnabled && updated.triggerTag && r.data.includeExisting === false) {
      let added = 0;
      do {
        const people = await this.store.taggedNotEnrolled(updated, 1000);
        added = people.length ? await this.store.enroll(updated, people, "SKIPPED", null) : 0;
      } while (added === 1000);
    }
    return updated;
  }

  async remove(tenantId: string, id: string) {
    const seq = await this.store.get(tenantId, id);
    if (!seq) throw new NotFoundError("Series not found");
    await this.store.remove(tenantId, id);
  }

  async people(tenantId: string, id: string) {
    const seq = await this.store.get(tenantId, id);
    if (!seq) throw new NotFoundError("Series not found");
    return this.store.people(tenantId, id, 300);
  }

  // إضافة يدوي (أرقام) - لازم السلسلة شغالة
  async enrollPhones(tenantId: string, id: string, body: unknown) {
    const r = enrollSchema.safeParse(body);
    if (!r.success) throw new ValidationError("Send a list of numbers");
    const seq = await this.store.get(tenantId, id);
    if (!seq) throw new NotFoundError("Series not found");
    if (!seq.enabled) throw new ValidationError("Turn the series on first");
    const people = new Map<string, string>();
    for (const p of r.data.phones ?? []) {
      const phone = normalizePhone(p.phone);
      if (phone) people.set(phone, (p.name ?? "").trim());
    }
    if (people.size === 0) throw new ValidationError("Enter at least one number with country code, e.g. 97455551234");
    const added = await this.store.enroll(seq, [...people].map(([phone, name]) => ({ phone, name })), "ACTIVE", nextStepAt(seq.steps, 0, this.now()));
    return { added, alreadyIn: people.size - added };
  }

  async stopOne(tenantId: string, id: string, enrollmentId: string) {
    if (!(await this.store.stopOne(tenantId, id, enrollmentId))) throw new NotFoundError("Not found");
    return { ok: true };
  }

  // كل دقيقة: (1) اللي خدوا التاج يدخلوا السلسلة (2) الرسايل اللي جه ميعادها تتبعت
  async runDue(limit = 100): Promise<{ enrolled: number; sent: number; stopped: number; failed: number }> {
    const now = this.now();
    let enrolled = 0;
    for (const seq of await this.store.enabledWithTag(200)) {
      const people = await this.store.taggedNotEnrolled(seq, 500);
      if (people.length) enrolled += await this.store.enroll(seq, people, "ACTIVE", nextStepAt(seq.steps, 0, now));
    }

    let sent = 0, stopped = 0, failed = 0;
    const due = await this.store.claimDue(now, new Date(now.getTime() + CLAIM_LEASE_MS), limit);
    const seqCache = new Map<string, SequenceRow | null>();
    for (const e of due) {
      if (!seqCache.has(e.sequenceId)) seqCache.set(e.sequenceId, await this.store.get(e.tenantId, e.sequenceId));
      const seq = seqCache.get(e.sequenceId) ?? null;
      const [contact, replied] = await Promise.all([this.store.contact(e.tenantId, e.phone), seq?.stopOnReply ? this.store.repliedSince(e.tenantId, e.phone, e.enrolledAt) : Promise.resolve(false)]);
      const d = decide(seq, e, contact, replied);
      if (d.action === "pause") {
        // السلسلة مقفولة: نرجع نبص كمان ساعة (الرسالة مابتضيعش)
        await this.store.finishStep(e.id, { stepIndex: e.stepIndex, status: "ACTIVE", nextAt: new Date(now.getTime() + 3600_000) });
        continue;
      }
      if (d.action === "done") {
        await this.store.finishStep(e.id, { stepIndex: e.stepIndex, status: "DONE", nextAt: null });
        continue;
      }
      if (d.action === "stop") {
        stopped++;
        await this.store.finishStep(e.id, { stepIndex: e.stepIndex, status: "STOPPED", nextAt: null, stopReason: d.reason });
        continue;
      }
      const step = seq!.steps[e.stepIndex];
      const r = await this.sender.send(e.tenantId, e.phone, e.name, step.templateId).catch((err: Error) => ({ ok: false, error: err.message }));
      if (r.ok) {
        sent++;
        const nextIndex = e.stepIndex + 1;
        const nextAt = nextStepAt(seq!.steps, nextIndex, now);
        await this.store.finishStep(e.id, { stepIndex: nextIndex, status: nextAt ? "ACTIVE" : "DONE", nextAt, lastSentAt: now, lastError: null });
      } else if (!e.lastError) {
        failed++;
        await this.store.finishStep(e.id, { stepIndex: e.stepIndex, status: "ACTIVE", nextAt: new Date(now.getTime() + RETRY_AFTER_MS), lastError: r.error ?? "Couldn't send" });
      } else {
        failed++;
        stopped++;
        await this.store.finishStep(e.id, { stepIndex: e.stepIndex, status: "STOPPED", nextAt: null, lastError: r.error ?? "Couldn't send", stopReason: `Couldn't send message ${e.stepIndex + 1}` });
      }
    }
    return { enrolled, sent, stopped, failed };
  }
}
