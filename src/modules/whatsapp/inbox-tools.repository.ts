import { Prisma, PrismaClient } from "@prisma/client";
import type { InboxMessenger, InboxSettings, InboxToolsStore, QuickReply } from "./inbox-tools.service";
import type { WeekHours } from "./inbox-hours";
import { recordWhatsappMessage, sendWhatsappTextMessage } from "./whatsapp.service";

const qrSelect = { id: true, shortcut: true, title: true, body: true, sortOrder: true } as const;
const DEFAULTS: InboxSettings = { autoAssign: "off", assignUserIds: [], awayEnabled: false, awayText: "", hours: null, timezone: null, awayEveryHours: 12 };

function toSettings(row: {
  autoAssign: string;
  assignUserIds: string[];
  awayEnabled: boolean;
  awayText: string;
  hours: Prisma.JsonValue | null;
  timezone: string | null;
  awayEveryHours: number;
} | null): InboxSettings {
  if (!row) return { ...DEFAULTS };
  return {
    autoAssign: row.autoAssign === "round_robin" ? "round_robin" : "off",
    assignUserIds: row.assignUserIds ?? [],
    awayEnabled: row.awayEnabled,
    awayText: row.awayText,
    hours: (row.hours as WeekHours | null) ?? null,
    timezone: row.timezone ?? null,
    awayEveryHours: row.awayEveryHours,
  };
}

export class PrismaInboxToolsRepository implements InboxToolsStore {
  constructor(private readonly db: PrismaClient) {}

  quickReplies(tenantId: string): Promise<QuickReply[]> {
    return this.db.whatsappQuickReply.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: qrSelect });
  }
  quickReply(tenantId: string, id: string) {
    return this.db.whatsappQuickReply.findFirst({ where: { id, tenantId }, select: qrSelect });
  }
  async shortcutTaken(tenantId: string, shortcut: string, exceptId?: string) {
    return (await this.db.whatsappQuickReply.count({ where: { tenantId, shortcut, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
  }
  createQuickReply(tenantId: string, data: Omit<QuickReply, "id">) {
    return this.db.whatsappQuickReply.create({ data: { tenantId, ...data }, select: qrSelect });
  }
  updateQuickReply(id: string, data: Partial<Omit<QuickReply, "id">>) {
    return this.db.whatsappQuickReply.update({ where: { id }, data, select: qrSelect });
  }
  async deleteQuickReply(id: string) {
    await this.db.whatsappQuickReply.delete({ where: { id } });
  }

  async settings(tenantId: string) {
    return toSettings(await this.db.whatsappInboxSettings.findUnique({ where: { tenantId } }));
  }
  async saveSettings(tenantId: string, s: InboxSettings) {
    const data = { ...s, hours: s.hours ? (s.hours as Prisma.InputJsonValue) : Prisma.DbNull };
    return toSettings(await this.db.whatsappInboxSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data }));
  }
  async activeUserIds(tenantId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db.user.findMany({ where: { tenantId, id: { in: ids }, isActive: true }, select: { id: true } });
    return rows.map((r) => r.id);
  }
  async companyTimezone(tenantId: string) {
    return (await this.db.bookingSettings.findUnique({ where: { tenantId }, select: { timezone: true } }))?.timezone ?? null;
  }

  async assignRoundRobin(tenantId: string, phone: string, pick: (activeIds: string[], last: string | null) => string | null) {
    return this.db.$transaction(async (tx) => {
      // قفل صف الإعدادات: رسالتين في نفس اللحظة مايختاروش نفس الموظف
      const locked = await tx.$queryRaw<{ lastAssignedUserId: string | null; assignUserIds: string[] }[]>`
        SELECT "lastAssignedUserId", "assignUserIds" FROM "whatsapp_inbox_settings" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
      if (!locked.length) return null;
      const conv = await tx.whatsappConversation.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        create: { tenantId, phone },
        update: {},
        select: { assignedToUserId: true },
      });
      if (conv.assignedToUserId) return null; // ليها مسؤول بالفعل
      const active = (await tx.user.findMany({ where: { tenantId, id: { in: locked[0].assignUserIds }, isActive: true }, select: { id: true } })).map((u) => u.id);
      const userId = pick(active, locked[0].lastAssignedUserId);
      if (!userId) return null;
      const done = await tx.whatsappConversation.updateMany({ where: { tenantId, phone, assignedToUserId: null }, data: { assignedToUserId: userId, assignedAt: new Date() } });
      if (!done.count) return null;
      await tx.whatsappInboxSettings.update({ where: { tenantId }, data: { lastAssignedUserId: userId } });
      return userId;
    });
  }

  async claimAway(tenantId: string, phone: string, now: Date, everyHours: number) {
    await this.db.whatsappConversation.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone }, update: {} });
    const cutoff = new Date(now.getTime() - everyHours * 3600_000);
    const r = await this.db.whatsappConversation.updateMany({
      where: { tenantId, phone, OR: [{ awaySentAt: null }, { awaySentAt: { lt: cutoff } }] },
      data: { awaySentAt: now },
    });
    return r.count > 0;
  }
}

export class MetaInboxMessenger implements InboxMessenger {
  constructor(private readonly senders: { senderFor(tenantId: string, opts: { customerPhone?: string | null }): Promise<{ token: string; phoneNumberId: string } | null> }) {}

  async sendText(tenantId: string, phone: string, name: string | null, text: string) {
    const s = await this.senders.senderFor(tenantId, { customerPhone: phone });
    if (!s) return false;
    const r = await sendWhatsappTextMessage(s.token, s.phoneNumberId, phone, text);
    await recordWhatsappMessage({
      tenantId,
      direction: "OUT",
      contactPhone: phone,
      contactName: name,
      body: text,
      kind: "away",
      waMessageId: r.messageId,
      status: r.ok ? "sent" : "failed",
      error: r.ok ? null : r.error,
      phoneNumberId: s.phoneNumberId,
    });
    return r.ok;
  }
}
