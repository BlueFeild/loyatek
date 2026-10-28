import { PrismaClient } from "@prisma/client";
import type { InboxAccount, InboxEvent, InboxKind, SocialPlatform } from "./social-types";

// اللي صندوق التعليقات والرسايل محتاجه من التخزين (Prisma هنا، ونسخة في الذاكرة للاختبارات)

export interface InboxAccountRow extends InboxAccount {
  id: string;
  tenantId: string;
  name: string;
  status: string;
}

export interface InboxMessageView {
  id: string;
  kind: string;
  direction: string;
  text: string;
  authorName: string | null;
  createdAt: Date;
  postCaption: string | null;
}

export interface ThreadView {
  accountId: string;
  platform: string;
  accountName: string;
  kind: InboxKind;
  threadKey: string;
  customerName: string | null;
  lastText: string;
  lastAt: Date;
  lastDirection: string;
  lastInboundAt: Date | null;
  unread: number;
  postCaption: string | null;
}

export interface InboxStore {
  // الصفحة/الحساب ممكن يكون متربط بأكتر من شركة - آخر شركة ربطته هي صاحبته
  ownerOf(platform: SocialPlatform, externalId: string): Promise<{ id: string; tenantId: string } | null>;
  account(tenantId: string, id: string): Promise<InboxAccountRow | null>;
  activeAccounts(tenantId: string): Promise<InboxAccountRow[]>;
  // بيرجّع عدد الجديد (اللي اتسجل قبل كده بيتجاهل)
  record(tenantId: string, accountId: string, events: InboxEvent[], sentById?: string | null): Promise<number>;
  threads(tenantId: string, filter: { kind?: InboxKind; accountId?: string }): Promise<ThreadView[]>;
  messages(tenantId: string, accountId: string, kind: InboxKind, threadKey: string): Promise<InboxMessageView[]>;
  markRead(tenantId: string, accountId: string, kind: InboxKind, threadKey: string): Promise<void>;
  unreadCount(tenantId: string): Promise<number>;
  // اسم العميل اللي اتسجل قبل كده في نفس المحادثة
  threadName(accountId: string, threadKey: string): Promise<string | null>;
}

const SOCIAL = ["FACEBOOK", "INSTAGRAM"];

export class PrismaInboxRepository implements InboxStore {
  constructor(private readonly db: PrismaClient) {}

  async ownerOf(platform: SocialPlatform, externalId: string) {
    return this.db.socialAccount.findFirst({ where: { platform, externalId, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, select: { id: true, tenantId: true } });
  }

  async account(tenantId: string, id: string) {
    const a = await this.db.socialAccount.findFirst({ where: { id, tenantId }, select: { id: true, tenantId: true, name: true, status: true, platform: true, externalId: true, parentId: true, accessToken: true } });
    return a ? { ...a, platform: a.platform as SocialPlatform } : null;
  }

  async activeAccounts(tenantId: string) {
    const rows = await this.db.socialAccount.findMany({
      where: { tenantId, status: "ACTIVE", platform: { in: SOCIAL } },
      select: { id: true, tenantId: true, name: true, status: true, platform: true, externalId: true, parentId: true, accessToken: true },
    });
    return rows.map((a) => ({ ...a, platform: a.platform as SocialPlatform }));
  }

  async record(tenantId: string, accountId: string, events: InboxEvent[], sentById: string | null = null) {
    if (!events.length) return 0;
    const r = await this.db.socialMessage.createMany({
      data: events.map((e) => ({
        tenantId,
        accountId,
        kind: e.kind,
        direction: e.direction,
        externalId: e.externalId,
        threadKey: e.threadKey,
        parentExternalId: e.parentExternalId,
        postExternalId: e.postExternalId,
        postCaption: e.postCaption,
        authorId: e.authorId,
        authorName: e.authorName,
        text: e.text.slice(0, 5000),
        sentById,
        createdAt: e.createdAt,
        // اللي التاجر نفسه كتبه مقري
        readAt: e.direction === "OUT" ? new Date() : null,
      })),
      skipDuplicates: true,
    });
    return r.count;
  }

  // آخر 2000 رسالة مجمّعة في محادثات (كفاية لصندوق تاجر واحد)
  async threads(tenantId: string, filter: { kind?: InboxKind; accountId?: string }) {
    const rows = await this.db.socialMessage.findMany({
      where: { tenantId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.accountId ? { accountId: filter.accountId } : {}), account: { status: { not: "DISCONNECTED" } } },
      orderBy: { createdAt: "desc" },
      take: 2000,
      select: { accountId: true, kind: true, threadKey: true, direction: true, text: true, authorName: true, createdAt: true, readAt: true, postCaption: true, account: { select: { platform: true, name: true } } },
    });
    const map = new Map<string, ThreadView>();
    for (const m of rows) {
      const key = `${m.accountId}|${m.kind}|${m.threadKey}`;
      let t = map.get(key);
      if (!t) {
        t = {
          accountId: m.accountId,
          platform: m.account.platform,
          accountName: m.account.name,
          kind: m.kind as InboxKind,
          threadKey: m.threadKey,
          customerName: null,
          lastText: m.text,
          lastAt: m.createdAt,
          lastDirection: m.direction,
          lastInboundAt: null,
          unread: 0,
          postCaption: null,
        };
        map.set(key, t);
      }
      if (m.direction === "IN") {
        if (!t.customerName && m.authorName) t.customerName = m.authorName;
        if (!t.lastInboundAt) t.lastInboundAt = m.createdAt;
        if (!m.readAt) t.unread++;
      }
      if (!t.postCaption && m.postCaption) t.postCaption = m.postCaption;
    }
    return [...map.values()].slice(0, 300);
  }

  messages(tenantId: string, accountId: string, kind: InboxKind, threadKey: string) {
    return this.db.socialMessage.findMany({
      where: { tenantId, accountId, kind, threadKey },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: { id: true, kind: true, direction: true, text: true, authorName: true, createdAt: true, postCaption: true },
    });
  }

  async markRead(tenantId: string, accountId: string, kind: InboxKind, threadKey: string) {
    await this.db.socialMessage.updateMany({ where: { tenantId, accountId, kind, threadKey, readAt: null }, data: { readAt: new Date() } });
  }

  async threadName(accountId: string, threadKey: string) {
    const m = await this.db.socialMessage.findFirst({ where: { accountId, threadKey, direction: "IN", authorName: { not: null } }, select: { authorName: true } });
    return m?.authorName ?? null;
  }

  unreadCount(tenantId: string) {
    return this.db.socialMessage.count({ where: { tenantId, direction: "IN", readAt: null, account: { status: { not: "DISCONNECTED" } } } });
  }
}
