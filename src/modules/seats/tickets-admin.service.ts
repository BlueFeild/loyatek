import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { isValidTimeZone, utcToZonedParts, zonedDateTimeToUtc } from "../../utils/timezone";
import { shortReference } from "../payment-settings/payment-methods";
import { allSeats, priceSeats, readLayout, seatLabel, SeatLayoutError } from "./seat-layout";
import { priceOrder, promoInput } from "./seat-pricing";
import { readQuestions } from "./seat-questions";
import { isUniqueViolation, publicOrder, readLayoutSafe, type SeatBookingService, type SeatPayments } from "./seat-booking.service";
import type { SeatRepository } from "./seat.repository";
import type { SeatSettingsStore } from "./seat-adapters";
import { BOOKING_TEMPLATES, COVER_MAX_CHARS, imageDataUrl, pageStyleSchema } from "../booking/page-design";

// شغل التاجر الإضافي في خدمة التذاكر: أكواد الخصم، البيع على الباب والتذاكر المجانية،
// التقارير و CSV، إعدادات الصفحة، قائمة الانتظار، ومواعيد إضافية لنفس العرض.
// المنطق هنا، والكلام مع الداتابيز في seat.repository.ts

const dataUrlImage = z.string().max(1_500_000).regex(/^data:image\/(png|jpeg|webp);base64,/, "Logo must be PNG, JPG or WebP");

export const settingsInput = z.object({
  brandName: z.string().trim().max(80).nullable().optional(),
  logoDataUrl: dataUrlImage.nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
  // نفس قوالب صفحة الحجز الفاتحة + ألوان التاجر
  pageTemplate: z.enum(BOOKING_TEMPLATES).optional(),
  pageStyle: pageStyleSchema.nullable().optional(),
  coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable().optional(),
});

export const sellInput = z.object({
  seatIds: z.array(z.string().max(12)).min(1).max(100),
  // SALE = بيع على الباب (اتدفع)، COMP = تذكرة مجانية (VIP/راعي/ضيف)
  kind: z.enum(["SALE", "COMP"]),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().max(30).optional().nullable(),
  customerEmail: z.union([z.literal(""), z.string().trim().email().max(200)]).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  // طريقة الدفع على الباب (كاش / كارت / تحويل ...)
  paymentLabel: z.string().trim().max(40).optional().nullable(),
  sendTicket: z.boolean().default(true),
});

export const datesInput = z.object({
  dates: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{1,2}:\d{2}$/) })).min(1).max(30),
});

const CHANNELS = ["ONLINE", "BOX_OFFICE", "COMP"] as const;

export class TicketsAdminService {
  constructor(
    private readonly repo: SeatRepository,
    private readonly seats: SeatBookingService,
    private readonly store: SeatSettingsStore,
    private readonly payments: SeatPayments,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ================= إعدادات صفحة التذاكر =================
  async getSettings(tenantId: string) {
    const [brand, tz, own] = await Promise.all([this.store.brand(tenantId), this.store.timezone(tenantId), this.repo.settings(tenantId)]);
    return {
      brandName: own?.brandName ?? null,
      logoDataUrl: own?.logoDataUrl ?? null,
      accentColor: own?.accentColor ?? null,
      timezone: own?.timezone ?? null,
      pageTemplate: own?.pageTemplate ?? "bluefield",
      pageStyle: own?.pageStyle ?? null,
      coverDataUrl: own?.coverDataUrl ?? null,
      effective: { ...brand, timezone: tz },
    };
  }
  async saveSettings(tenantId: string, input: z.infer<typeof settingsInput>) {
    if (input.timezone && !isValidTimeZone(input.timezone)) throw new ValidationError("Unknown time zone.");
    const { pageStyle, ...rest } = input;
    await this.repo.saveSettings(tenantId, {
      ...rest,
      brandName: input.brandName === undefined ? undefined : input.brandName || null,
      ...(pageStyle !== undefined ? { pageStyle: pageStyle ?? Prisma.DbNull } : {}),
    });
    return this.getSettings(tenantId);
  }

  // ================= أكواد الخصم =================
  listPromos(tenantId: string) {
    return this.repo.listPromos(tenantId).then((l) => l.map(promoOut));
  }
  async createPromo(tenantId: string, input: z.infer<typeof promoInput>) {
    if (input.eventId) await this.seats.requireEvent(tenantId, input.eventId);
    try {
      return promoOut(await this.repo.createPromo({ tenantId, ...input, maxUses: input.maxUses ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, eventId: input.eventId ?? null }));
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "PROMO_EXISTS", "You already have a code with this name.");
      throw e;
    }
  }
  async updatePromo(tenantId: string, id: string, input: Partial<z.infer<typeof promoInput>>) {
    if (input.eventId) await this.seats.requireEvent(tenantId, input.eventId);
    try {
      const p = await this.repo.updatePromo(tenantId, id, input);
      if (!p) throw new NotFoundError("Code not found");
      return promoOut(p);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, "PROMO_EXISTS", "You already have a code with this name.");
      throw e;
    }
  }
  async deletePromo(tenantId: string, id: string) {
    if (!(await this.repo.deletePromo(tenantId, id))) throw new NotFoundError("Code not found");
  }

  // ================= بيع على الباب / تذكرة مجانية =================
  async sell(tenantId: string, eventId: string, input: z.infer<typeof sellInput>) {
    const event = await this.seats.requireEvent(tenantId, eventId);
    if (event.status === "CANCELLED") throw new AppError(409, "EVENT_CANCELLED", "This show is cancelled.");
    const layout = readLayout(event.layout);
    let ids: string[];
    try {
      ids = priceSeats(layout, input.seatIds).seats.map((s) => s.id);
    } catch (e) {
      if (e instanceof SeatLayoutError) throw new ValidationError(e.message);
      throw e;
    }
    await this.repo.releaseExpired(eventId, this.now());
    const price = priceOrder(layout, ids, { earlyBird: { pct: event.earlyBirdPct, endsAt: event.earlyBirdEndsAt }, now: this.now() });
    const comp = input.kind === "COMP";
    const amount = comp ? 0 : price.amount;
    try {
      const order = await this.repo.createDirect({
        tenantId,
        eventId,
        seatIds: ids,
        amount,
        subtotal: price.subtotal,
        discount: price.subtotal - amount,
        customerName: input.customerName,
        customerPhone: input.customerPhone || null,
        customerEmail: input.customerEmail || null,
        note: input.note || null,
        channel: comp ? "COMP" : "BOX_OFFICE",
        paymentStatus: amount > 0 ? "PAID" : "NOT_REQUIRED",
        paymentMethodLabel: comp ? "Free ticket" : input.paymentLabel || "Paid at the door",
        ticketCode: crypto.randomBytes(10).toString("hex").toUpperCase(),
      });
      if (input.sendTicket && (order.customerPhone || order.customerEmail)) await this.seats.notifyConfirmed(order);
      return publicOrder(order);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw Object.assign(new AppError(409, "SEATS_TAKEN", "One of these seats was just booked — please pick again."), { details: { taken: await this.repo.takenSeats(eventId) } });
      }
      throw e;
    }
  }

  // ================= مواعيد إضافية لنفس العرض =================
  async addDates(tenantId: string, eventId: string, input: z.infer<typeof datesInput>) {
    const src = await this.seats.requireEvent(tenantId, eventId);
    const seriesId = src.seriesId ?? src.id;
    if (!src.seriesId) await this.repo.updateEvent(tenantId, src.id, { seriesId });
    const tz = await this.store.timezone(tenantId);
    const existing = new Set((await this.repo.seriesEvents(tenantId, seriesId)).map((e) => e.startsAt.getTime()));
    existing.add(src.startsAt.getTime());
    const created = [];
    for (const d of input.dates) {
      const at = zonedDateTimeToUtc(d.date, d.time, tz);
      if (!at) throw new ValidationError("Please enter a valid date and time.");
      if (existing.has(at.getTime())) continue; // نفس الميعاد موجود
      existing.add(at.getTime());
      const layout = readLayout(src.layout);
      created.push(
        await this.repo.createEvent({
          tenantId,
          venueId: src.venueId,
          title: src.title,
          description: src.description,
          imageDataUrl: src.imageDataUrl,
          startsAt: at,
          layout,
          status: src.status,
          maxPerOrder: src.maxPerOrder,
          holdMinutes: src.holdMinutes,
          seriesId,
          earlyBirdPct: src.earlyBirdPct,
          earlyBirdEndsAt: src.earlyBirdEndsAt,
          questions: readQuestions(src.questions),
          notice: src.notice,
          noticeRequired: src.noticeRequired,
          avoidSingleSeats: src.avoidSingleSeats,
          reminderHours: src.reminderHours,
        })
      );
    }
    return { created: created.map((e) => ({ id: e.id, startsAt: e.startsAt, local: utcToZonedParts(e.startsAt, tz) })) };
  }

  // ================= قائمة الانتظار =================
  async waitlist(tenantId: string, eventId: string) {
    await this.seats.requireEvent(tenantId, eventId);
    return this.repo.listWaitlist(tenantId, eventId);
  }
  async removeWaitlist(tenantId: string, id: string) {
    if (!(await this.repo.setWaitlistStatus(tenantId, id, "REMOVED"))) throw new NotFoundError("Not found");
  }
  async notifyWaitlist(tenantId: string, eventId: string) {
    return { sent: await this.seats.notifyWaitlist(tenantId, eventId) };
  }

  // ================= التقرير =================
  async report(tenantId: string, eventId: string) {
    const event = await this.seats.requireEvent(tenantId, eventId);
    const layout = readLayoutSafe(event.layout);
    const [orders, tz, waitlist] = await Promise.all([this.repo.listOrders(tenantId, eventId), this.store.timezone(tenantId), this.repo.listWaitlist(tenantId, eventId)]);
    const tierOf = new Map(layout ? allSeats(layout).map((s) => [s.id, s.tier]) : []);
    const priceOf = new Map(layout ? layout.tiers.map((t) => [t.id, t.price]) : []);
    const capacity = layout ? allSeats(layout).filter((s) => !s.blocked).length : 0;

    const tiers = new Map((layout?.tiers ?? []).map((t) => [t.id, { id: t.id, name: t.name, color: t.color, seats: allSeats(layout!).filter((s) => s.tier === t.id && !s.blocked).length, sold: 0, pending: 0, comp: 0, revenue: 0 }]));
    const channels = Object.fromEntries(CHANNELS.map((c) => [c, { orders: 0, seats: 0, revenue: 0 }])) as Record<string, { orders: number; seats: number; revenue: number }>;
    const methods = new Map<string, { orders: number; revenue: number }>();
    const promos = new Map<string, { code: string; orders: number; discount: number }>();
    const daily = new Map<string, { date: string; seats: number; revenue: number }>();
    let revenue = 0, discount = 0, sold = 0, pending = 0, checkedIn = 0, cancelled = 0, awaitingMoney = 0;

    for (const o of orders) {
      if (o.status === "CANCELLED") { cancelled++; continue; }
      const amount = Number(o.amount);
      const paid = o.paymentStatus === "PAID" || o.paymentStatus === "NOT_REQUIRED";
      const n = o.seatIds.length;
      if (o.status === "CONFIRMED") sold += n; else pending += n;
      if (o.checkedInAt) checkedIn += n;
      if (!paid) awaitingMoney += amount;
      const ch = channels[o.channel] ?? channels.ONLINE;
      ch.orders++; ch.seats += n;
      // نوزّع المبلغ على الكراسي بنسبة سعر كل كرسي
      const full = o.seatIds.reduce((t, id) => t + (priceOf.get(tierOf.get(id) ?? "") ?? 0), 0);
      for (const id of o.seatIds) {
        const t = tiers.get(tierOf.get(id) ?? "");
        if (!t) continue;
        if (o.channel === "COMP") t.comp++;
        else if (o.status === "CONFIRMED") t.sold++;
        else t.pending++;
        if (paid && full > 0) t.revenue += (amount * (priceOf.get(tierOf.get(id) ?? "") ?? 0)) / full;
      }
      if (!paid) continue;
      revenue += amount;
      discount += Number(o.discount);
      ch.revenue += amount;
      const m = methods.get(o.paymentMethodLabel || "Free") ?? { orders: 0, revenue: 0 };
      m.orders++; m.revenue += amount;
      methods.set(o.paymentMethodLabel || "Free", m);
      if (o.promoCode) {
        const p = promos.get(o.promoCode) ?? { code: o.promoCode, orders: 0, discount: 0 };
        p.orders++; p.discount += Number(o.discount);
        promos.set(o.promoCode, p);
      }
      const day = utcToZonedParts(o.createdAt, tz).date;
      const d = daily.get(day) ?? { date: day, seats: 0, revenue: 0 };
      d.seats += n; d.revenue += amount;
      daily.set(day, d);
    }
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    return {
      event: { id: event.id, title: event.title, local: utcToZonedParts(event.startsAt, tz), status: event.status },
      capacity, sold, pending, checkedIn, cancelled,
      free: Math.max(0, capacity - sold - pending),
      revenue: r6(revenue), discount: r6(discount), awaitingMoney: r6(awaitingMoney),
      tiers: [...tiers.values()].map((t) => ({ ...t, revenue: r6(t.revenue) })),
      channels,
      methods: [...methods.entries()].map(([label, v]) => ({ label, ...v, revenue: r6(v.revenue) })),
      promos: [...promos.values()].map((p) => ({ ...p, discount: r6(p.discount) })),
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, revenue: r6(d.revenue) })),
      waitlist: { waiting: waitlist.filter((w) => w.status === "WAITING").length, notified: waitlist.filter((w) => w.status === "NOTIFIED").length },
    };
  }

  // كل الطلبات في ملف CSV (يتفتح في Excel) - المبالغ بعملة الشركة
  async ordersCsv(tenantId: string, eventId: string) {
    const event = await this.seats.requireEvent(tenantId, eventId);
    const [orders, tz] = await Promise.all([this.repo.listOrders(tenantId, eventId), this.store.timezone(tenantId)]);
    const layout = readLayoutSafe(event.layout);
    const tierOf = new Map(layout ? allSeats(layout).map((s) => [s.id, s.tier]) : []);
    const tierName = new Map((layout?.tiers ?? []).map((t) => [t.id, t.name]));
    const questions = readQuestions(event.questions);
    const header = ["Reference", "Name", "Phone", "Email", "Seats", "Levels", "Channel", "Status", "Payment", "Method", "Currency", "Full price", "Discount", "Paid amount", "Promo code", "Note", ...questions.map((q) => q.label), "Checked in", "Booked at"];
    const lines = [header];
    for (const o of [...orders].reverse()) {
      const [full, disc, amt] = await Promise.all([Number(o.subtotal), Number(o.discount), Number(o.amount)].map((v) => this.payments.payable(tenantId, v)));
      const answers = (o.answers ?? {}) as Record<string, string>;
      const booked = utcToZonedParts(o.createdAt, tz);
      const inAt = o.checkedInAt ? utcToZonedParts(o.checkedInAt, tz) : null;
      lines.push([
        shortReference(o.id), o.customerName ?? "", o.customerPhone ?? "", o.customerEmail ?? "",
        o.seatIds.map(seatLabel).join(" "),
        Array.from(new Set(o.seatIds.map((id) => tierName.get(tierOf.get(id) ?? "") ?? ""))).join(" / "),
        o.channel, o.status, o.paymentStatus, o.paymentMethodLabel ?? "", amt.currency,
        String(full.amount), String(disc.amount), String(amt.amount), o.promoCode ?? "", o.note ?? "",
        ...questions.map((q) => answers[q.id] ?? ""),
        inAt ? `${inAt.date} ${inAt.time}` : "", `${booked.date} ${booked.time}`,
      ]);
    }
    // علامة BOM عشان Excel يقرا العربي صح
    return "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
  }
}

// الخلية في CSV: بين علامتين + منع الصيغ في Excel (= @ أو + - من غير رقم بعدها)
export function csvCell(v: string) {
  const safe = /^[=@\t\r]|^[+-](?!\d)/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

function promoOut(p: { value: unknown } & Record<string, unknown>) {
  return { ...p, value: Number(p.value) };
}
