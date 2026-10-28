import type { InboxEvent } from "./social-types";

// بيحوّل اللي Meta بتبعته على الـ webhook (object = page أو instagram) لأحداث موحّدة.
// دالة نقية (من غير قاعدة بيانات) عشان تتختبر لوحدها

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : typeof v === "number" ? String(v) : null;
}

function when(v: unknown): Date {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string") {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * 1000 : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function parseSocialWebhook(body: any): InboxEvent[] {
  const object = body?.object;
  if (object !== "page" && object !== "instagram") return [];
  const platform = object === "page" ? "FACEBOOK" : "INSTAGRAM";
  const out: InboxEvent[] = [];

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    const accountId = str(entry?.id);
    if (!accountId) continue;

    // ---- تعليقات ----
    for (const ch of Array.isArray(entry.changes) ? entry.changes : []) {
      const v = ch?.value ?? {};
      if (platform === "FACEBOOK" && ch?.field === "feed" && v.item === "comment" && v.verb === "add") {
        const id = str(v.comment_id);
        const text = str(v.message);
        if (!id || !text) continue;
        const postId = str(v.post_id);
        const parent = str(v.parent_id);
        // في فيسبوك التعليق الأساسي الـ parent بتاعه هو البوست نفسه
        const isReply = Boolean(parent && parent !== postId);
        const fromId = str(v.from?.id);
        out.push({
          platform,
          accountExternalId: accountId,
          kind: "COMMENT",
          direction: fromId === accountId ? "OUT" : "IN",
          externalId: id,
          threadKey: isReply ? parent! : id,
          parentExternalId: isReply ? parent : null,
          postExternalId: postId,
          postCaption: str(v.post?.message),
          authorId: fromId,
          authorName: str(v.from?.name),
          text,
          createdAt: when(v.created_time),
        });
      }
      if (platform === "INSTAGRAM" && ch?.field === "comments") {
        const id = str(v.id);
        const text = str(v.text);
        if (!id || !text) continue;
        const parent = str(v.parent_id);
        const fromId = str(v.from?.id);
        out.push({
          platform,
          accountExternalId: accountId,
          kind: "COMMENT",
          direction: fromId === accountId ? "OUT" : "IN",
          externalId: id,
          threadKey: parent ?? id,
          parentExternalId: parent,
          postExternalId: str(v.media?.id),
          postCaption: null,
          authorId: fromId,
          authorName: str(v.from?.username),
          text,
          createdAt: when(v.timestamp ?? entry.time),
        });
      }
    }

    // ---- رسايل خاصة (Messenger / Instagram Direct) ----
    for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const msg = m?.message;
      const mid = str(msg?.mid);
      if (!mid || msg?.is_deleted) continue;
      const echo = Boolean(msg.is_echo);
      const sender = str(m.sender?.id);
      const recipient = str(m.recipient?.id);
      const customer = echo ? recipient : sender;
      if (!customer) continue;
      const text = str(msg.text) ?? (Array.isArray(msg.attachments) && msg.attachments.length ? `[${msg.attachments[0]?.type ?? "attachment"}]` : null);
      if (!text) continue;
      out.push({
        platform,
        accountExternalId: accountId,
        kind: "DM",
        direction: echo ? "OUT" : "IN",
        externalId: mid,
        threadKey: customer,
        parentExternalId: null,
        postExternalId: null,
        postCaption: null,
        authorId: sender,
        authorName: null,
        text,
        createdAt: when(m.timestamp),
      });
    }
  }
  return out;
}
