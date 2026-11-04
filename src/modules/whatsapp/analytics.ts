// إحصائيات واتساب الحقيقية (من الرسايل المتسجلة) - حسابات بس، من غير قاعدة بيانات

export interface AnalyticsMessage {
  contactPhone: string;
  direction: string; // IN | OUT
  kind: string;
  status: string;
  createdAt: Date;
}

export interface WhatsappAnalytics {
  days: number;
  totals: { inbound: number; outbound: number; conversations: number; newContacts: number; optedOut: number; needsPerson: number };
  // مين رد: الموظف الذكي / البوت / الفريق / الحملات / رسايل الحجز والتأكيد
  answeredBy: { ai: number; bot: number; team: number; campaigns: number; automatic: number };
  delivery: { sent: number; delivered: number; read: number; failed: number; deliveredPct: number; readPct: number };
  // أول رد بعد ما العميل يكتب (بالدقايق)
  response: { answered: number; unanswered: number; medianMinutes: number | null; within5MinPct: number | null };
  peakHours: number[]; // 24 خانة = رسايل العملاء في كل ساعة (بتوقيت الشركة)
  daily: { date: string; inbound: number; outbound: number }[];
}

const AI = new Set(["ai"]);
const BOT = new Set(["bot", "bot-fallback"]);
const TEAM = new Set(["text", "app"]);
const CAMPAIGN = new Set(["campaign"]);

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

function hourIn(date: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date);
    return Number(h) % 24;
  } catch {
    return date.getUTCHours();
  }
}

function dayIn(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function summarizeWhatsapp(
  messages: AnalyticsMessage[],
  opts: { days: number; now: Date; timeZone: string; newContacts: number; optedOut: number; needsPerson: number }
): WhatsappAnalytics {
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const answeredBy = { ai: 0, bot: 0, team: 0, campaigns: 0, automatic: 0 };
  const delivery = { sent: 0, delivered: 0, read: 0, failed: 0 };
  const peakHours = Array.from({ length: 24 }, () => 0);
  const daily = new Map<string, { inbound: number; outbound: number }>();
  for (let i = opts.days - 1; i >= 0; i--) daily.set(dayIn(new Date(opts.now.getTime() - i * 86400_000), opts.timeZone), { inbound: 0, outbound: 0 });
  const phones = new Set<string>();
  let inbound = 0;
  let outbound = 0;

  // وقت الرد: أول رسالة من العميل بعد آخر رد مننا ← أول رد (مش حملة) بعدها
  const waitingSince = new Map<string, Date>();
  const responseMinutes: number[] = [];

  for (const m of sorted) {
    phones.add(m.contactPhone);
    const day = daily.get(dayIn(m.createdAt, opts.timeZone));
    if (m.direction === "IN") {
      inbound++;
      if (day) day.inbound++;
      peakHours[hourIn(m.createdAt, opts.timeZone)]++;
      if (!waitingSince.has(m.contactPhone)) waitingSince.set(m.contactPhone, m.createdAt);
      continue;
    }
    outbound++;
    if (day) day.outbound++;
    if (AI.has(m.kind)) answeredBy.ai++;
    else if (BOT.has(m.kind)) answeredBy.bot++;
    else if (TEAM.has(m.kind)) answeredBy.team++;
    else if (CAMPAIGN.has(m.kind)) answeredBy.campaigns++;
    else answeredBy.automatic++;

    if (m.status === "failed") delivery.failed++;
    else {
      delivery.sent++;
      if (m.status === "delivered" || m.status === "read") delivery.delivered++;
      if (m.status === "read") delivery.read++;
    }

    const since = waitingSince.get(m.contactPhone);
    if (since && !CAMPAIGN.has(m.kind)) {
      responseMinutes.push((m.createdAt.getTime() - since.getTime()) / 60000);
      waitingSince.delete(m.contactPhone);
    }
  }

  const ordered = [...responseMinutes].sort((a, b) => a - b);
  const median = ordered.length ? ordered[Math.floor((ordered.length - 1) / 2)] : null;
  return {
    days: opts.days,
    totals: { inbound, outbound, conversations: phones.size, newContacts: opts.newContacts, optedOut: opts.optedOut, needsPerson: opts.needsPerson },
    answeredBy,
    delivery: { ...delivery, deliveredPct: pct(delivery.delivered, delivery.sent), readPct: pct(delivery.read, delivery.sent) },
    response: {
      answered: ordered.length,
      unanswered: waitingSince.size,
      medianMinutes: median === null ? null : Math.round(median * 10) / 10,
      within5MinPct: ordered.length ? pct(ordered.filter((x) => x <= 5).length, ordered.length) : null,
    },
    peakHours,
    daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })),
  };
}
