import type { PrismaClient } from "@prisma/client";
import type { HelpCategory, HelpMailer, HelpStatus, HelpStore } from "./help-desk.service";
import { sendEmail } from "../../utils/email";
import { createNotification } from "../notifications/notifications.service";

// كل كلام Prisma لصندوق "محتاج مساعدة؟" هنا بس
export class PrismaHelpRepository implements HelpStore {
  constructor(private readonly db: PrismaClient) {}

  countCreatedSince(tenantId: string, since: Date) {
    return this.db.helpTicket.count({ where: { tenantId, createdAt: { gte: since } } });
  }

  create(d: { tenantId: string; userId: string; subject: string; message: string; category: HelpCategory; pageUrl: string | null }) {
    return this.db.helpTicket.create({ data: d });
  }

  find(id: string, tenantId: string | null) {
    return this.db.helpTicket.findFirst({ where: tenantId ? { id, tenantId } : { id } });
  }

  private async withCounts<T extends { id: string }>(rows: T[]) {
    if (!rows.length) return [];
    const counts = await this.db.helpReply.groupBy({ by: ["ticketId"], where: { ticketId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const m = new Map(counts.map((c) => [c.ticketId, c._count._all]));
    return rows.map((r) => ({ ...r, replyCount: m.get(r.id) ?? 0 }));
  }

  async listForTenant(tenantId: string) {
    return this.withCounts(await this.db.helpTicket.findMany({ where: { tenantId }, orderBy: { lastActivityAt: "desc" }, take: 100 }));
  }

  async listAll(status: HelpStatus | null) {
    return this.withCounts(await this.db.helpTicket.findMany({ where: status ? { status } : {}, orderBy: { lastActivityAt: "desc" }, take: 300 }));
  }

  async countByStatus() {
    const rows = await this.db.helpTicket.groupBy({ by: ["status"], _count: { _all: true } });
    const out: Record<HelpStatus, number> = { OPEN: 0, ANSWERED: 0, CLOSED: 0 };
    for (const r of rows) if (r.status in out) out[r.status as HelpStatus] = r._count._all;
    return out;
  }

  replies(ticketId: string) {
    return this.db.helpReply.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" }, take: 500 });
  }

  async addReply(ticketId: string, d: { fromSuperAdmin: boolean; authorUserId: string; message: string; status: HelpStatus }) {
    const [reply] = await this.db.$transaction([
      this.db.helpReply.create({ data: { ticketId, fromSuperAdmin: d.fromSuperAdmin, authorUserId: d.authorUserId, message: d.message } }),
      this.db.helpTicket.update({ where: { id: ticketId }, data: { status: d.status, lastActivityAt: new Date(), lastFromSuperAdmin: d.fromSuperAdmin } }),
    ]);
    return reply;
  }

  async setStatus(ticketId: string, status: HelpStatus) {
    await this.db.helpTicket.update({ where: { id: ticketId }, data: { status } });
  }

  people(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  }

  companies(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
  }
}

// عنوان فريق الدعم: متغير SUPPORT_EMAIL على Railway، وإلا العنوان الافتراضي
export function supportEmailAddress() {
  return process.env.SUPPORT_EMAIL?.trim() || "support@blue-field.co";
}

export class EmailHelpMailer implements HelpMailer {
  toSupport(subject: string, text: string, replyTo?: string) {
    return sendEmail(supportEmailAddress(), subject, text, { replyTo });
  }
  toMerchant(email: string, subject: string, text: string) {
    return sendEmail(email, subject, text);
  }
  notifyTenant(tenantId: string, title: string, body: string, link: string) {
    return createNotification({ tenantId, type: "SUPPORT_REPLY", title, body, link });
  }
}
