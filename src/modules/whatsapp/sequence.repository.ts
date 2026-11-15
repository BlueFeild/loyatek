import { Prisma, PrismaClient } from "@prisma/client";
import type { EnrollmentRow, SequenceRow, SequenceStep, SequenceStore, TemplateInfo } from "./sequence.service";

// سلاسل الرسايل: Prisma بس (المنطق في sequence.service.ts)

type DbSequence = { id: string; tenantId: string; name: string; enabled: boolean; triggerTag: string | null; stopOnReply: boolean; steps: Prisma.JsonValue; createdAt: Date };

function toRow(s: DbSequence): SequenceRow {
  return { ...s, steps: Array.isArray(s.steps) ? (s.steps as unknown as SequenceStep[]) : [] };
}

const SEQ_FIELDS = { id: true, tenantId: true, name: true, enabled: true, triggerTag: true, stopOnReply: true, steps: true, createdAt: true } as const;

export class PrismaSequenceRepository implements SequenceStore {
  constructor(private readonly db: PrismaClient) {}

  async list(tenantId: string) {
    return (await this.db.whatsappSequence.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: SEQ_FIELDS })).map(toRow);
  }

  async get(tenantId: string, id: string) {
    const s = await this.db.whatsappSequence.findFirst({ where: { id, tenantId }, select: SEQ_FIELDS });
    return s ? toRow(s) : null;
  }

  async create(tenantId: string, data: { name: string; triggerTag: string | null; stopOnReply: boolean; steps: SequenceStep[] }) {
    return toRow(await this.db.whatsappSequence.create({ data: { tenantId, ...data, steps: data.steps as unknown as Prisma.InputJsonValue }, select: SEQ_FIELDS }));
  }

  async update(tenantId: string, id: string, data: Partial<{ name: string; triggerTag: string | null; stopOnReply: boolean; steps: SequenceStep[]; enabled: boolean }>) {
    const { steps, ...rest } = data;
    await this.db.whatsappSequence.updateMany({ where: { id, tenantId }, data: { ...rest, ...(steps ? { steps: steps as unknown as Prisma.InputJsonValue } : {}) } });
    return (await this.get(tenantId, id))!;
  }

  async remove(tenantId: string, id: string) {
    await this.db.whatsappSequence.deleteMany({ where: { id, tenantId } });
  }

  async templates(tenantId: string, ids: string[]): Promise<TemplateInfo[]> {
    if (!ids.length) return [];
    return this.db.whatsappTemplate.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, status: true, bodyText: true } });
  }

  async counts(tenantId: string) {
    const rows = await this.db.whatsappSequenceEnrollment.groupBy({ by: ["sequenceId", "status"], where: { tenantId }, _count: { _all: true } });
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const m = out.get(r.sequenceId) ?? {};
      m[r.status] = r._count._all;
      out.set(r.sequenceId, m);
    }
    return out;
  }

  async people(tenantId: string, sequenceId: string, limit: number) {
    return this.db.whatsappSequenceEnrollment.findMany({
      where: { tenantId, sequenceId, status: { not: "SKIPPED" } },
      orderBy: { enrolledAt: "desc" },
      take: limit,
      select: { id: true, tenantId: true, sequenceId: true, phone: true, name: true, stepIndex: true, status: true, enrolledAt: true, lastError: true, nextAt: true, lastSentAt: true, stopReason: true },
    });
  }

  async taggedNotEnrolled(seq: SequenceRow, limit: number) {
    if (!seq.triggerTag) return [];
    const rows = await this.db.$queryRaw<{ phone: string; name: string | null }[]>`
      SELECT c."phone", c."name" FROM "whatsapp_contacts" c
      WHERE c."tenantId" = ${seq.tenantId} AND c."optedOut" = false AND ${seq.triggerTag} = ANY(c."tags")
        AND NOT EXISTS (SELECT 1 FROM "whatsapp_sequence_enrollments" e WHERE e."sequenceId" = ${seq.id} AND e."phone" = c."phone")
      ORDER BY c."updatedAt" ASC
      LIMIT ${limit}`;
    return rows.map((r) => ({ phone: r.phone, name: r.name ?? "" }));
  }

  async enroll(seq: SequenceRow, people: { phone: string; name: string }[], status: "ACTIVE" | "SKIPPED", nextAt: Date | null) {
    if (!people.length) return 0;
    const r = await this.db.whatsappSequenceEnrollment.createMany({
      data: people.map((p) => ({ tenantId: seq.tenantId, sequenceId: seq.id, phone: p.phone, name: p.name, status, nextAt: status === "ACTIVE" ? nextAt : null })),
      skipDuplicates: true,
    });
    return r.count;
  }

  async enabledWithTag(limit: number) {
    return (await this.db.whatsappSequence.findMany({ where: { enabled: true, triggerTag: { not: null }, tenant: { accountStatus: "ACTIVE" } }, take: limit, select: SEQ_FIELDS })).map(toRow);
  }

  // حجز ذرّي (FOR UPDATE SKIP LOCKED): كل صف بيمسكه سيرفر واحد بس، ومهلة الحجز = nextAt الجديد
  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<EnrollmentRow[]> {
    return this.db.$queryRaw<EnrollmentRow[]>`
      UPDATE "whatsapp_sequence_enrollments" SET "nextAt" = ${leaseUntil}
      WHERE "id" IN (
        SELECT e."id" FROM "whatsapp_sequence_enrollments" e
        JOIN "tenants" t ON t."id" = e."tenantId" AND t."accountStatus" = 'ACTIVE'
        WHERE e."status" = 'ACTIVE' AND e."nextAt" IS NOT NULL AND e."nextAt" <= ${now}
        ORDER BY e."nextAt" ASC
        LIMIT ${limit}
        FOR UPDATE OF e SKIP LOCKED
      )
      RETURNING "id", "tenantId", "sequenceId", "phone", "name", "stepIndex", "status", "enrolledAt", "lastError"`;
  }

  async finishStep(id: string, data: { stepIndex: number; status: string; nextAt: Date | null; lastSentAt?: Date; lastError?: string | null; stopReason?: string | null }) {
    await this.db.whatsappSequenceEnrollment.update({ where: { id }, data });
  }

  async stopOne(tenantId: string, sequenceId: string, enrollmentId: string) {
    const r = await this.db.whatsappSequenceEnrollment.updateMany({
      where: { id: enrollmentId, tenantId, sequenceId, status: "ACTIVE" },
      data: { status: "STOPPED", nextAt: null, stopReason: "Stopped by you" },
    });
    return r.count > 0;
  }

  async contact(tenantId: string, phone: string) {
    return this.db.whatsappContact.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { optedOut: true } });
  }

  async repliedSince(tenantId: string, phone: string, since: Date) {
    const m = await this.db.whatsappMessage.findFirst({ where: { tenantId, contactPhone: phone, direction: "IN", createdAt: { gt: since } }, select: { id: true } });
    return Boolean(m);
  }
}
