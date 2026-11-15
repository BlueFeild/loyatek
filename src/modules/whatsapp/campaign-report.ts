// تقرير الحملة من رسايلها نفسها: Meta بتبعت الحالة (sent ← delivered ← read أو failed) على الـ webhook،
// و"رد" = العميل بعت أي رسالة بعد ما الحملة وصلته (خلال 7 أيام)
export const REPLY_WINDOW_MS = 7 * 24 * 3600_000;

// ترتيب الحالات: الحالة مابترجعش لورا (delivered متأخرة بعد read ماتنزّلهاش)
export const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

// الحالات اللي مسموح الرسالة تتحدث منها للحالة الجديدة
export function statusesBelow(next: string): string[] | null {
  if (next === "failed") return null; // failed بتتسجل دايمًا
  const rank = STATUS_RANK[next];
  if (!rank) return null;
  return Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s] < rank).concat("received");
}

export interface ReportMessage {
  contactPhone: string;
  contactName: string | null;
  status: string;
  error: string | null;
  createdAt: Date;
}

export interface CampaignReport {
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
  skipped: number;
  rates: { delivered: number; read: number; replied: number };
  recipients: { phone: string; name: string | null; status: string; error: string | null; replied: boolean }[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// inbound = أول رسالة جاية من كل رقم بعد إرسال الحملة له
export function summarizeCampaign(messages: ReportMessage[], firstReplyAt: Map<string, Date>, skipped: number, listLimit = 300): CampaignReport {
  let sent = 0;
  let delivered = 0;
  let read = 0;
  let failed = 0;
  let replied = 0;
  const recipients: CampaignReport["recipients"] = [];
  for (const m of messages) {
    const rank = STATUS_RANK[m.status] ?? 0;
    if (m.status === "failed") failed++;
    else if (rank >= 1) sent++;
    if (rank >= 2) delivered++;
    if (rank >= 3) read++;
    const reply = firstReplyAt.get(m.contactPhone);
    const didReply = Boolean(reply && reply.getTime() >= m.createdAt.getTime() && reply.getTime() - m.createdAt.getTime() <= REPLY_WINDOW_MS);
    if (didReply) replied++;
    if (recipients.length < listLimit) recipients.push({ phone: m.contactPhone, name: m.contactName, status: m.status, error: m.error, replied: didReply });
  }
  return {
    total: messages.length,
    sent,
    delivered,
    read,
    failed,
    replied,
    skipped,
    rates: { delivered: pct(delivered, sent), read: pct(read, sent), replied: pct(replied, sent) },
    recipients,
  };
}

// "إعادة استهداف": حملة متابعة لجزء من اللي وصلتهم الحملة (زي WATI - بس من التقرير مباشرة)
export const RETARGET_GROUPS = ["not_read", "not_replied", "replied", "failed"] as const;
export type RetargetGroup = (typeof RETARGET_GROUPS)[number];

export const RETARGET_LABEL: Record<RetargetGroup, string> = {
  not_read: "didn't read it",
  not_replied: "didn't reply",
  replied: "replied",
  failed: "didn't get it",
};

export function pickRetarget(recipients: CampaignReport["recipients"], group: RetargetGroup): { phone: string; name: string }[] {
  const keep = (r: CampaignReport["recipients"][number]) => {
    if (group === "failed") return r.status === "failed";
    if (r.status === "failed") return false;
    if (group === "not_read") return r.status !== "read";
    if (group === "not_replied") return !r.replied;
    return r.replied;
  };
  const seen = new Set<string>();
  const out: { phone: string; name: string }[] = [];
  for (const r of recipients) {
    if (!keep(r) || seen.has(r.phone)) continue;
    seen.add(r.phone);
    out.push({ phone: r.phone, name: r.name ?? "" });
  }
  return out;
}
