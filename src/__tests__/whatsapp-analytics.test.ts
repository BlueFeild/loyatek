import { describe, expect, it } from "vitest";
import { summarizeWhatsapp, type AnalyticsMessage } from "../modules/whatsapp/analytics";

const at = (iso: string) => new Date(iso);
const msg = (contactPhone: string, direction: "IN" | "OUT", createdAt: string, kind = "text", status = direction === "IN" ? "received" : "sent"): AnalyticsMessage => ({ contactPhone, direction, kind, status, createdAt: at(createdAt) });

describe("summarizeWhatsapp", () => {
  const now = at("2026-11-04T12:00:00Z");
  const messages = [
    // سارة: كتبت 09:00 (12:00 الدوحة) ← الموظف الذكي رد بعد دقيقتين
    msg("1", "IN", "2026-11-04T09:00:00Z"),
    msg("1", "OUT", "2026-11-04T09:02:00Z", "ai", "read"),
    // علي: كتب مرتين ← الفريق رد بعد 20 دقيقة من أول رسالة
    msg("2", "IN", "2026-11-03T08:00:00Z"),
    msg("2", "IN", "2026-11-03T08:05:00Z"),
    msg("2", "OUT", "2026-11-03T08:20:00Z", "text", "delivered"),
    // حملة لنور (مش رد) وبعدين كتبت ومحدش رد
    msg("3", "OUT", "2026-11-02T10:00:00Z", "campaign", "failed"),
    msg("3", "IN", "2026-11-02T10:30:00Z"),
    msg("4", "OUT", "2026-11-02T11:00:00Z", "bot"),
    msg("4", "OUT", "2026-11-02T11:01:00Z", "template", "delivered"),
  ];
  const r = summarizeWhatsapp(messages, { days: 7, now, timeZone: "Asia/Qatar", newContacts: 3, optedOut: 1, needsPerson: 2 });

  it("totals and who answered", () => {
    expect(r.totals).toEqual({ inbound: 4, outbound: 5, conversations: 4, newContacts: 3, optedOut: 1, needsPerson: 2 });
    expect(r.answeredBy).toEqual({ ai: 1, bot: 1, team: 1, campaigns: 1, automatic: 1 });
  });

  it("delivery rates leave out failed messages", () => {
    expect(r.delivery).toMatchObject({ sent: 4, delivered: 3, read: 1, failed: 1, deliveredPct: 75, readPct: 25 });
  });

  it("first response time from the first waiting message; campaigns aren't replies", () => {
    expect(r.response).toEqual({ answered: 2, unanswered: 1, medianMinutes: 2, within5MinPct: 50 });
  });

  it("peak hours and daily series use the company's timezone", () => {
    expect(r.peakHours[12]).toBe(1); // 09:00 UTC = 12:00 الدوحة
    expect(r.peakHours[11]).toBe(2);
    expect(r.daily).toHaveLength(7);
    expect(r.daily[6]).toEqual({ date: "2026-11-04", inbound: 1, outbound: 1 });
    expect(r.daily.find((d) => d.date === "2026-11-02")).toEqual({ date: "2026-11-02", inbound: 1, outbound: 3 });
  });

  it("empty account", () => {
    const e = summarizeWhatsapp([], { days: 30, now, timeZone: "Asia/Qatar", newContacts: 0, optedOut: 0, needsPerson: 0 });
    expect(e.response).toEqual({ answered: 0, unanswered: 0, medianMinutes: null, within5MinPct: null });
    expect(e.delivery.deliveredPct).toBe(0);
    expect(e.daily).toHaveLength(30);
  });
});
