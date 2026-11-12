import crypto from "crypto";
import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { confirmsOnOrder, pickPaymentMethod, shortReference, type PaymentMethod } from "../payment-settings/payment-methods";
import { allSeats, applyEventLayoutChanges, layoutSchema, priceSeats, readLayout, seatLabel, SeatLayoutError, tierSchema, type SeatLayout } from "./seat-layout";
import { ACTIVE_ORDER, type SeatEventRow, type SeatOrderRow, type SeatRepository } from "./seat.repository";
import { earlyBirdActive, priceOrder, promoAppliesTo, promoProblem, type PromoRule } from "./seat-pricing";
import { bestAvailable, lonelySeatLeft, lonelySeatMessage } from "./seat-picking";
import { checkAnswers, questionsSchema, readQuestions } from "./seat-questions";
import { utcToZonedParts, zonedDateTimeToUtc } from "../../utils/timezone";

// ---------- الواجهات اللي الخدمة محتاجاها (بتتوصل في container.ts) ----------
export interface SeatPayments {
  methods(tenantId: string): Promise<PaymentMethod[]>;
  // المبلغ بالدولار -> المبلغ اللي العميل يدفعه بعملة الشركة
  payable(tenantId: string, usd: number): Promise<{ amount: number; currency: string }>;
  start(tenantId: string, method: PaymentMethod, input: { amount: number; redirectionUrl: string; reference: string }): Promise<{ ok: boolean; paymentUrl?: string; invoiceId?: string; error?: string }>;
  check(tenantId: string, paymentId: string, invoiceId: string | null): Promise<boolean>;
}

export interface SeatTicketInfo {
  tenantId: string;
  title: string;
  startsAt: Date;
  seats: string[];
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  ticketCode: string;
  amountText: string | null;
}

export interface SeatNotifier {
  confirmed(info: SeatTicketInfo): Promise<void>;
  // تذكير قبل العرض
  reminder(info: SeatTicketInfo): Promise<boolean>;
  // كراسي فضيت لحد في قائمة الانتظار
  waitlistOpen(info: { tenantId: string; eventId: string; title: string; startsAt: Date; name: string; phone: string; email: string | null }): Promise<boolean>;
}

export interface SeatSettingsReader {
  timezone(tenantId: string): Promise<string>;
}

export const EVENT_STATUSES = ["DRAFT", "ON_SALE", "CLOSED", "CANCELLED"] as const;

export const venueInput = z.object({ name: z.string().trim().min(1).max(80), layout: layoutSchema });
export const eventInput = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  imageDataUrl: z
    .string()
    .max(3_000_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,/, "Photo must be PNG, JPG or WebP")
    .nullable()
    .optional(),
  venueId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{1,2}:\d{2}$/),
  status: z.enum(EVENT_STATUSES).default("DRAFT"),
  maxPerOrder: z.number().int().min(1).max(50).default(10),
  holdMinutes: z.number().int().min(3).max(30).default(10),
  // سعر مبكر: خصم % لحد آخر يوم (بتوقيت الشركة)
  earlyBirdPct: z.number().int().min(1).max(90).nullable().optional(),
  earlyBirdUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  questions: questionsSchema.optional(),
  notice: z.string().trim().max(500).nullable().optional(),
  noticeRequired: z.boolean().optional(),
  avoidSingleSeats: z.boolean().optional(),
  reminderHours: z.number().int().min(1).max(72).nullable().optional(),
});
export const eventPatch = eventInput.omit({ venueId: true }).partial().extend({ tiers: z.array(tierSchema).optional(), blocked: z.array(z.string().max(12)).max(1500).optional() });

export const checkoutInput = z.object({
  holdToken: z.string().min(16).max(80),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().min(6).max(30),
  customerEmail: z.union([z.literal(""), z.string().trim().email().max(200)]).optional(),
  paymentMethodId: z.string().max(64).optional(),
  promoCode: z.string().trim().max(24).optional(),
  answers: z.record(z.string().max(24), z.string().max(300)).optional(),
  noticeAccepted: z.boolean().optional(),
});

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const newTicketCode = () => crypto.randomBytes(10).toString("hex").toUpperCase();

export class SeatBookingService {
  constructor(
    private readonly repo: SeatRepository,
    private readonly payments: SeatPayments,
    private readonly notifier: SeatNotifier,
    private readonly settings: SeatSettingsReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ================= القاعات (التاجر) =================
  listVenues(tenantId: string) {
    return this.repo.listVenues(tenantId);
  }
  createVenue(tenantId: string, input: z.infer<typeof venueInput>) {
    return this.repo.createVenue(tenantId, input.name, input.layout);
  }
  async updateVenue(tenantId: string, id: string, input: Partial<z.infer<typeof venueInput>>) {
    const v = await this.repo.updateVenue(tenantId, id, { name: input.name, layout: input.layout });
    if (!v) throw new NotFoundError("Hall not found");
    return v;
  }
  async deleteVenue(tenantId: string, id: string) {
    // العروض اللي اتعملت منها بتفضل شغالة (معاها نسخة من الشكل)
    if (!(await this.repo.deleteVenue(tenantId, id))) throw new NotFoundError("Hall not found");
  }

  // ================= العروض (التاجر) =================
  async listEvents(tenantId: string) {
    const [events, stats, tz] = await Promise.all([this.repo.listEvents(tenantId), this.repo.eventStats(tenantId), this.settings.timezone(tenantId)]);
    return events.map((e) => {
      const layout = readLayoutSafe(e.layout);
      const capacity = layout ? allSeats(layout).filter((s) => !s.blocked).length : 0;
      const { imageDataUrl: _i, layout: _l, ...rest } = e;
      return { ...rest, hasImage: Boolean(e.imageDataUrl), venueName: e.venue?.name ?? null, local: utcToZonedParts(e.startsAt, tz), capacity, ...(stats.get(e.id) ?? { sold: 0, pending: 0, revenue: 0, checkedIn: 0 }) };
    });
  }

  async createEvent(tenantId: string, input: z.infer<typeof eventInput>) {
    const venue = await this.repo.findVenue(tenantId, input.venueId);
    if (!venue) throw new NotFoundError("Hall not found");
    const startsAt = await this.startsAt(tenantId, input.date, input.time);
    return this.repo.createEvent({
      tenantId,
      venueId: venue.id,
      title: input.title,
      description: input.description || null,
      imageDataUrl: input.imageDataUrl || null,
      startsAt,
      layout: readLayout(venue.layout),
      status: input.status,
      maxPerOrder: input.maxPerOrder,
      holdMinutes: input.holdMinutes,
      ...(await this.extras(tenantId, input)),
    });
  }

  // الحقول الإضافية للعرض (سعر مبكر، أسئلة، تنبيه، تذكير)
  private async extras(tenantId: string, input: Partial<z.infer<typeof eventInput>>) {
    const data: Record<string, unknown> = {};
    if (input.earlyBirdPct !== undefined) data.earlyBirdPct = input.earlyBirdPct;
    if (input.earlyBirdUntil !== undefined) data.earlyBirdEndsAt = input.earlyBirdUntil ? await this.startsAt(tenantId, input.earlyBirdUntil, "23:59") : null;
    if (input.questions !== undefined) data.questions = input.questions;
    if (input.notice !== undefined) data.notice = input.notice || null;
    for (const k of ["noticeRequired", "avoidSingleSeats", "reminderHours"] as const) if (input[k] !== undefined) data[k] = input[k];
    return data;
  }

  async updateEvent(tenantId: string, id: string, input: z.infer<typeof eventPatch>) {
    const event = await this.requireEvent(tenantId, id);
    const data: Record<string, unknown> = {};
    for (const k of ["title", "status", "maxPerOrder", "holdMinutes"] as const) if (input[k] !== undefined) data[k] = input[k];
    if (input.description !== undefined) data.description = input.description || null;
    if (input.imageDataUrl !== undefined) data.imageDataUrl = input.imageDataUrl || null;
    Object.assign(data, await this.extras(tenantId, input));
    if (input.date || input.time) {
      const tz = await this.settings.timezone(tenantId);
      const cur = utcToZonedParts(event.startsAt, tz);
      data.startsAt = await this.startsAt(tenantId, input.date ?? cur.date, input.time ?? cur.time);
    }
    if (input.tiers || input.blocked) {
      await this.repo.releaseExpired(id, this.now());
      const taken = new Set(await this.repo.takenSeats(id));
      try {
        data.layout = applyEventLayoutChanges(readLayout(event.layout), { tiers: input.tiers, blocked: input.blocked }, taken);
      } catch (e) {
        if (e instanceof SeatLayoutError) throw new ValidationError(e.message);
        throw e;
      }
    }
    return this.repo.updateEvent(tenantId, id, data);
  }

  async deleteEvent(tenantId: string, id: string) {
    await this.requireEvent(tenantId, id);
    if ((await this.repo.countActiveOrders(id)) > 0) {
      throw new AppError(409, "EVENT_HAS_TICKETS", "This show already has tickets — set it to Cancelled instead of deleting it.");
    }
    await this.repo.deleteEvent(tenantId, id);
  }

  // تفاصيل العرض للتاجر: الخريطة + مين حاجز كل كرسي + الطلبات
  async eventDetail(tenantId: string, id: string) {
    const event = await this.requireEvent(tenantId, id);
    await this.repo.releaseExpired(id, this.now());
    const [reservations, orders, tz] = await Promise.all([this.repo.reservationsWithOrders(id), this.repo.listOrders(tenantId, id), this.settings.timezone(tenantId)]);
    const seats: Record<string, { status: string; orderId: string; name: string | null }> = {};
    for (const r of reservations) {
      const st = r.order.status === "CONFIRMED" ? (r.order.checkedInAt ? "in" : "sold") : r.order.status === "AWAITING_PAYMENT" ? "pending" : "held";
      seats[r.seatId] = { status: st, orderId: r.order.id, name: r.order.customerName };
    }
    return { ...event, venueName: event.venue?.name ?? null, local: utcToZonedParts(event.startsAt, tz), timezone: tz, seats, orders: orders.map(publicOrder) };
  }

  // ================= العميل (صفحة عامة) =================
  async publicEvents(tenantId: string) {
    const [events, tz] = await Promise.all([this.repo.publicEvents(tenantId, this.now()), this.settings.timezone(tenantId)]);
    const taken = await this.repo.takenCounts(events.map((e) => e.id));
    return events.map((e) => {
      const layout = readLayoutSafe(e.layout);
      const eb = earlyBirdActive({ pct: e.earlyBirdPct, endsAt: e.earlyBirdEndsAt }, this.now());
      const prices = layout ? layout.tiers.map((t) => t.price * (1 - eb / 100)) : [];
      const capacity = layout ? allSeats(layout).filter((x) => !x.blocked).length : 0;
      return {
        id: e.id,
        seriesId: e.seriesId,
        title: e.title,
        description: e.description,
        imageDataUrl: e.imageDataUrl,
        startsAt: e.startsAt,
        local: utcToZonedParts(e.startsAt, tz),
        venueName: e.venue?.name ?? null,
        fromPrice: prices.length ? Math.round(Math.min(...prices) * 1e6) / 1e6 : 0,
        earlyBirdPct: eb || null,
        soldOut: capacity > 0 && (taken.get(e.id) ?? 0) >= capacity,
      };
    });
  }

  async publicEvent(tenantId: string, id: string) {
    const event = await this.requireEvent(tenantId, id);
    if (event.status !== "ON_SALE") throw new NotFoundError("This show isn't on sale.");
    await this.repo.releaseExpired(id, this.now());
    const [taken, tz] = await Promise.all([this.repo.takenSeats(id), this.settings.timezone(tenantId)]);
    const layout = readLayout(event.layout);
    const capacity = allSeats(layout).filter((x) => !x.blocked).length;
    const eb = earlyBirdActive({ pct: event.earlyBirdPct, endsAt: event.earlyBirdEndsAt }, this.now());
    const soldOut = taken.length >= capacity;
    return {
      id: event.id,
      seriesId: event.seriesId,
      earlyBird: eb ? { pct: eb, endsAt: event.earlyBirdEndsAt, local: event.earlyBirdEndsAt ? utcToZonedParts(event.earlyBirdEndsAt, tz) : null } : null,
      questions: readQuestions(event.questions),
      notice: event.notice,
      noticeRequired: event.noticeRequired,
      avoidSingleSeats: event.avoidSingleSeats,
      soldOut,
      free: Math.max(0, capacity - taken.length),
      otherDates: await this.otherDates(event, tz),
      title: event.title,
      description: event.description,
      imageDataUrl: event.imageDataUrl,
      startsAt: event.startsAt,
      local: utcToZonedParts(event.startsAt, tz),
      timezone: tz,
      venueName: event.venue?.name ?? null,
      layout,
      taken,
      maxPerOrder: event.maxPerOrder,
      holdMinutes: event.holdMinutes,
      past: event.startsAt <= this.now(),
    };
  }

  // العميل اختار كراسي -> بتتحجز له مؤقتًا (holdMinutes) لحد ما يكمل بياناته
  // best = "اختارلي أحسن كراسي": عدد + فئة اختيارية بدل ما العميل يدوس على الخريطة
  async hold(tenantId: string, eventId: string, seatIds: string[], replace?: { orderId?: string; token?: string }, best?: { count: number; tierId?: string | null }) {
    const event = await this.requireEvent(tenantId, eventId);
    if (event.status !== "ON_SALE") throw new AppError(409, "NOT_ON_SALE", "Tickets for this show aren't on sale right now.");
    if (event.startsAt <= this.now()) throw new AppError(409, "EVENT_STARTED", "This show has already started.");
    const layout = readLayout(event.layout);
    await this.repo.releaseExpired(eventId, this.now());
    // الكراسي اللي العميل نفسه ماسكها دلوقتي (لو بيغيّر اختياره) مش محسوبة محجوزة
    const mine = replace?.orderId && replace.token ? await this.heldSeatsOf(tenantId, replace.orderId, replace.token) : [];
    const takenNow = (await this.repo.takenSeats(eventId)).filter((id) => !mine.includes(id));
    if (best) {
      if (best.count > event.maxPerOrder) throw new ValidationError(`You can book up to ${event.maxPerOrder} seats at a time.`);
      const picked = bestAvailable(layout, takenNow, best.count, best.tierId);
      if (!picked) throw new AppError(409, "NO_SEATS_TOGETHER", `There aren't ${best.count} seats together${best.tierId ? " in this level" : ""} — please pick seats on the map.`);
      seatIds = picked;
    }
    if (seatIds.length < 1) throw new ValidationError("Please pick at least one seat.");
    if (seatIds.length > event.maxPerOrder) throw new ValidationError(`You can book up to ${event.maxPerOrder} seats at a time.`);
    let priced;
    try {
      priced = priceSeats(layout, seatIds);
    } catch (e) {
      if (e instanceof SeatLayoutError) throw new ValidationError(e.message);
      throw e;
    }
    // كرسي محجوز أصلًا: نفس رد التصادم (قبل قاعدة الكرسي الوحيد عشان الرسالة تبقى صح)
    const takenSet = new Set(takenNow);
    if (priced.seats.some((x) => takenSet.has(x.id))) {
      throw Object.assign(new AppError(409, "SEATS_TAKEN", "Someone just took one of these seats — please pick again."), { details: { taken: takenNow } });
    }
    if (event.avoidSingleSeats) {
      const lonely = lonelySeatLeft(layout, takenNow, priced.seats.map((x) => x.id));
      if (lonely) throw Object.assign(new AppError(422, "LONELY_SEAT", lonelySeatMessage(lonely)), { details: { seat: lonely } });
    }
    const price = priceOrder(layout, priced.seats.map((x) => x.id), { earlyBird: { pct: event.earlyBirdPct, endsAt: event.earlyBirdEndsAt }, now: this.now() });
    const token = crypto.randomBytes(24).toString("hex");
    try {
      const order = await this.repo.createHold({
        tenantId,
        eventId,
        seatIds: priced.seats.map((s) => s.id),
        amount: price.amount,
        subtotal: price.subtotal,
        discount: price.discount,
        holdTokenHash: sha(token),
        holdExpiresAt: new Date(this.now().getTime() + event.holdMinutes * 60000),
        ticketCode: newTicketCode(),
        replaceOrderId: replace?.orderId,
        replaceTokenHash: replace?.token ? sha(replace.token) : undefined,
      });
      return { orderId: order.id, holdToken: token, expiresAt: order.holdExpiresAt, amount: price.amount, subtotal: price.subtotal, discount: price.discount, seats: order.seatIds };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const taken = await this.repo.takenSeats(eventId);
        throw Object.assign(new AppError(409, "SEATS_TAKEN", "Someone just took one of these seats — please pick again."), { details: { taken } });
      }
      throw err;
    }
  }

  // العميل غيّر رأيه - الكراسي ترجع متاحة على طول
  async release(tenantId: string, orderId: string, token: string) {
    const order = await this.repo.findOrder(tenantId, orderId);
    if (!order || order.status !== "HELD" || order.holdTokenHash !== sha(token)) return;
    await this.repo.cancelOrder(order.id, ["HELD"]);
  }

  // العميل كتب كود خصم: نوريه السعر الجديد (من غير ما نستهلك الكود)
  async previewPromo(tenantId: string, orderId: string, holdToken: string, code: string) {
    const { order, event } = await this.heldOrder(tenantId, orderId, holdToken);
    const promo = await this.validPromo(tenantId, event, order.seatIds, code);
    const price = priceOrder(readLayout(event.layout), order.seatIds, { earlyBird: { pct: event.earlyBirdPct, endsAt: event.earlyBirdEndsAt }, promo, now: this.now() });
    return { code: promo.code, ...price };
  }

  async checkout(tenantId: string, orderId: string, input: z.infer<typeof checkoutInput>, redirectionUrlBase: string) {
    const { order, event } = await this.heldOrder(tenantId, orderId, input.holdToken);
    if (event.noticeRequired && event.notice && !input.noticeAccepted) throw new ValidationError("Please read and accept the show notice first.");
    const checked = checkAnswers(readQuestions(event.questions), input.answers);
    if (!checked.ok) throw new ValidationError(checked.error);
    // السعر بيتحسب تاني هنا (السعر المبكر ممكن يكون خلص + الكود)
    const promo = input.promoCode ? await this.validPromo(tenantId, event, order.seatIds, input.promoCode) : null;
    const price = priceOrder(readLayout(event.layout), order.seatIds, { earlyBird: { pct: event.earlyBirdPct, endsAt: event.earlyBirdEndsAt }, promo, now: this.now() });
    if (promo && !(await this.repo.claimPromo(promo.id))) throw new ValidationError("This code has been fully used.");
    const amount = price.amount;
    const paymentOn = amount > 0;
    let method: PaymentMethod | null = null;
    if (paymentOn) {
      const methods = await this.payments.methods(tenantId);
      method = methods.length ? pickPaymentMethod(methods, input.paymentMethodId) : null;
      if (!method) {
        if (promo) await this.repo.unclaimPromo(promo.id);
        if (methods.length === 0) throw new AppError(409, "NO_PAYMENT_METHOD", "This business hasn't set up a payment method yet.");
        throw new ValidationError("Please choose one of the available payment methods.");
      }
    }
    const confirmedNow = !paymentOn || (method !== null && confirmsOnOrder(method.type));
    const customer = {
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail || null,
      amount: price.amount,
      subtotal: price.subtotal,
      discount: price.discount,
      promoCodeId: promo?.id ?? null,
      promoCode: promo?.code ?? null,
      answers: checked.answers ?? undefined,
      noticeAcceptedAt: input.noticeAccepted ? this.now() : null,
    };
    // HELD -> الحالة الجديدة (بشرط إنه لسه HELD ووقته ماخلصش) - يمنع الدفع مرتين
    const updated = await this.repo.transition(
      order.id,
      { status: "HELD", holdExpiresAt: { gt: this.now() } },
      {
        ...customer,
        status: confirmedNow ? "CONFIRMED" : "AWAITING_PAYMENT",
        holdExpiresAt: null,
        paymentStatus: paymentOn ? "AWAITING_PAYMENT" : "NOT_REQUIRED",
        paymentMethodType: method?.type ?? null,
        paymentMethodLabel: method?.label ?? null,
      }
    );
    if (!updated) {
      if (promo) await this.repo.unclaimPromo(promo.id);
      throw new AppError(410, "HOLD_EXPIRED", "Your seats were released because time ran out — please pick them again.");
    }

    const pay = paymentOn ? await this.payments.payable(tenantId, amount) : null;
    const instructions = method && pay ? { type: method.type, label: method.label, details: method.details ?? null, amount: pay.amount, currency: pay.currency, reference: shortReference(order.id) } : null;

    if (confirmedNow) {
      await this.notifyConfirmed(updated);
      return { order: publicOrder(updated), paymentUrl: null, paymentInstructions: instructions };
    }
    if (method!.type === "BANK_TRANSFER") return { order: publicOrder(updated), paymentUrl: null, paymentInstructions: instructions };

    const started = await this.payments.start(tenantId, method!, { amount: pay!.amount, redirectionUrl: `${redirectionUrlBase}?seatOrder=${order.id}`, reference: order.id });
    if (!started.ok) {
      // الدفع مااشتغلش - نرجّع الكراسي متاحة عشان ماتفضلش محجوزة على الفاضي
      await this.repo.cancelOrder(order.id, ["AWAITING_PAYMENT"]);
      throw new AppError(502, "PAYMENT_START_FAILED", started.error || "The payment page didn't open — please try again.");
    }
    const withPay = await this.repo.transition(order.id, {}, { myFatoorahInvoiceId: started.invoiceId ?? null, myFatoorahPaymentUrl: started.paymentUrl ?? null });
    return { order: publicOrder(withPay ?? updated), paymentUrl: started.paymentUrl ?? null, paymentInstructions: null };
  }

  // رجوع العميل من MyFatoorah: بنسأل MyFatoorah نفسها (مش بنصدق الرابط)
  async confirmPayment(tenantId: string, orderId: string, paymentId: string | undefined) {
    const order = await this.repo.findOrder(tenantId, orderId);
    if (!order) throw new NotFoundError("Booking not found");
    if (order.status === "AWAITING_PAYMENT" && order.paymentMethodType === "MYFATOORAH" && paymentId) {
      if ((await this.repo.findOrderByInvoice(tenantId, paymentId, order.id)) === null && (await this.payments.check(tenantId, paymentId, order.myFatoorahInvoiceId))) {
        const paid = await this.repo.transition(order.id, { status: "AWAITING_PAYMENT" }, { status: "CONFIRMED", paymentStatus: "PAID", myFatoorahPaymentId: paymentId });
        if (paid) {
          await this.notifyConfirmed(paid);
          return publicOrder(paid);
        }
      }
    }
    return publicOrder((await this.repo.findOrder(tenantId, orderId)) ?? order);
  }

  // ================= التاجر: الطلبات =================
  async markPaid(tenantId: string, orderId: string) {
    const order = await this.requireOrder(tenantId, orderId);
    if (order.paymentStatus === "PAID") return publicOrder(order);
    if (order.paymentStatus !== "AWAITING_PAYMENT" || !["AWAITING_PAYMENT", "CONFIRMED"].includes(order.status)) {
      throw new AppError(409, "NOT_AWAITING_PAYMENT", "This booking isn't waiting for payment.");
    }
    const wasConfirmed = order.status === "CONFIRMED";
    const updated = await this.repo.transition(order.id, { paymentStatus: "AWAITING_PAYMENT", status: { in: ["AWAITING_PAYMENT", "CONFIRMED"] } }, { status: "CONFIRMED", paymentStatus: "PAID" });
    if (!updated) return publicOrder(await this.requireOrder(tenantId, orderId));
    // كاش على الباب: التذكرة اتبعتت وقت الحجز خلاص
    if (!wasConfirmed) await this.notifyConfirmed(updated);
    return publicOrder(updated);
  }

  async cancelOrder(tenantId: string, orderId: string) {
    const order = await this.requireOrder(tenantId, orderId);
    if (order.status === "CANCELLED") return publicOrder(order);
    if (!(await this.repo.cancelOrder(order.id, [...ACTIVE_ORDER]))) throw new AppError(409, "CANNOT_CANCEL", "This booking can't be cancelled.");
    // كراسي فضيت: نبلّغ قائمة الانتظار
    await this.notifyWaitlist(tenantId, order.eventId).catch(() => 0);
    return publicOrder(await this.requireOrder(tenantId, orderId));
  }

  // الكشف على الباب بالكود (من الـ QR أو كتابة)
  async checkIn(tenantId: string, rawCode: string) {
    const code = rawCode.replace(/^.*\/ticket\//, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
    const order = code ? await this.repo.findOrderByTicket(code) : null;
    if (!order || order.tenantId !== tenantId) throw new NotFoundError("No ticket with this code.");
    const info = { order: publicOrder(order), event: { id: order.event.id, title: order.event.title, startsAt: order.event.startsAt } };
    if (order.status !== "CONFIRMED") throw Object.assign(new AppError(409, "TICKET_NOT_VALID", order.status === "AWAITING_PAYMENT" ? "This ticket isn't paid yet." : "This ticket was cancelled."), { details: info });
    if (order.checkedInAt) throw Object.assign(new AppError(409, "ALREADY_CHECKED_IN", "This ticket was already used."), { details: info });
    if (!(await this.repo.checkIn(tenantId, code, this.now()))) throw Object.assign(new AppError(409, "ALREADY_CHECKED_IN", "This ticket was already used."), { details: info });
    return { ...info, order: { ...info.order, checkedInAt: this.now() }, unpaid: order.paymentStatus === "AWAITING_PAYMENT" };
  }

  // ================= التذكرة العامة =================
  async ticket(rawCode: string) {
    const code = rawCode.replace(/[^0-9a-f]/gi, "").toUpperCase();
    const order = code.length === 20 ? await this.repo.findOrderByTicket(code) : null;
    if (!order || !["CONFIRMED", "AWAITING_PAYMENT"].includes(order.status)) return null;
    const tz = await this.settings.timezone(order.tenantId);
    const layout = readLayoutSafe(order.event.layout);
    const tierOf = new Map(layout ? allSeats(layout).map((s) => [s.id, s.tier]) : []);
    const tiers = new Map(layout ? layout.tiers.map((t) => [t.id, t]) : []);
    return {
      tenantId: order.tenantId,
      code: order.ticketCode,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethodLabel: order.paymentMethodLabel,
      customerName: order.customerName,
      checkedInAt: order.checkedInAt,
      amount: Number(order.amount),
      reference: shortReference(order.id),
      seats: order.seatIds.map((id) => ({ id, label: seatLabel(id), tier: tiers.get(tierOf.get(id) ?? "")?.name ?? null, color: tiers.get(tierOf.get(id) ?? "")?.color ?? null })),
      event: { title: order.event.title, startsAt: order.event.startsAt, local: utcToZonedParts(order.event.startsAt, tz), timezone: tz, venueName: order.event.venue?.name ?? null, imageDataUrl: order.event.imageDataUrl, cancelled: order.event.status === "CANCELLED" },
    };
  }

  // ================= قائمة الانتظار =================
  // العميل بيسجّل لما العرض يكون كامل (أو مفيش كراسي كفاية)
  async joinWaitlist(tenantId: string, eventId: string, input: { name: string; phone: string; email?: string | null; seats: number }) {
    const event = await this.requireEvent(tenantId, eventId);
    if (event.status !== "ON_SALE" || event.startsAt <= this.now()) throw new AppError(409, "NOT_ON_SALE", "This show isn't taking bookings.");
    if (input.seats > event.maxPerOrder) throw new ValidationError(`You can ask for up to ${event.maxPerOrder} seats.`);
    await this.repo.releaseExpired(eventId, this.now());
    if (this.freeSeats(event, (await this.repo.takenSeats(eventId)).length) >= input.seats) {
      throw new AppError(409, "SEATS_AVAILABLE", "There are seats available — you can book them now.");
    }
    if ((await this.repo.countWaitlist(eventId)) >= 1000) throw new AppError(409, "WAITLIST_FULL", "The waiting list for this show is full.");
    const phone = input.phone.replace(/[^\d+]/g, "");
    if (phone.replace(/\D/g, "").length < 6) throw new ValidationError("Please enter a valid WhatsApp number.");
    await this.repo.upsertWaitlist({ tenantId, eventId, name: input.name, phone, email: input.email || null, seats: input.seats });
    return { ok: true };
  }

  // بنبعت لأول الناس في الانتظار اللي الكراسي الفاضية تكفيهم (كل واحد مرة واحدة)
  async notifyWaitlist(tenantId: string, eventId: string) {
    const event = await this.requireEvent(tenantId, eventId);
    if (event.status !== "ON_SALE" || event.startsAt <= this.now()) return 0;
    await this.repo.releaseExpired(eventId, this.now());
    let free = this.freeSeats(event, (await this.repo.takenSeats(eventId)).length);
    let sent = 0;
    for (const w of await this.repo.listWaitlist(tenantId, eventId)) {
      if (free <= 0) break;
      if (w.status !== "WAITING" || w.seats > free) continue;
      if (!(await this.repo.markWaitlistNotified(w.id, this.now()))) continue;
      await this.notifier.waitlistOpen({ tenantId, eventId, title: event.title, startsAt: event.startsAt, name: w.name, phone: w.phone, email: w.email }).catch(() => false);
      free -= w.seats;
      sent++;
    }
    return sent;
  }

  // ================= التذكير قبل العرض =================
  async runReminders() {
    const now = this.now();
    let sent = 0;
    for (const o of await this.repo.reminderCandidates(now)) {
      const hours = o.event.reminderHours ?? 0;
      const windowStart = o.event.startsAt.getTime() - hours * 3600_000;
      // حجز اتعمل جوه فترة التذكير = كفاية رسالة التذكرة
      if (!hours || now.getTime() < windowStart || o.createdAt.getTime() >= windowStart) continue;
      if (!(await this.repo.claimReminder(o.id, now))) continue;
      const ok = await this.notifier.reminder(this.ticketInfo(o, o.event, null)).catch(() => false);
      if (ok) sent++;
    }
    return sent;
  }

  // ---------- مساعدات ----------
  private freeSeats(event: SeatEventRow, taken: number) {
    const layout = readLayoutSafe(event.layout);
    return layout ? allSeats(layout).filter((x) => !x.blocked).length - taken : 0;
  }
  private async otherDates(event: SeatEventRow, tz: string) {
    if (!event.seriesId) return [];
    const list = (await this.repo.seriesEvents(event.tenantId, event.seriesId)).filter((e) => e.id !== event.id && e.status === "ON_SALE" && e.startsAt > this.now());
    const taken = await this.repo.takenCounts(list.map((e) => e.id));
    return list.map((e) => {
      const layout = readLayoutSafe(e.layout);
      const cap = layout ? allSeats(layout).filter((x) => !x.blocked).length : 0;
      return { id: e.id, startsAt: e.startsAt, local: utcToZonedParts(e.startsAt, tz), soldOut: cap > 0 && (taken.get(e.id) ?? 0) >= cap };
    });
  }
  private async heldSeatsOf(tenantId: string, orderId: string, token: string) {
    const o = await this.repo.findOrder(tenantId, orderId);
    return o && o.status === "HELD" && o.holdTokenHash === sha(token) ? o.seatIds : [];
  }
  private async heldOrder(tenantId: string, orderId: string, holdToken: string) {
    const order = await this.repo.findOrder(tenantId, orderId);
    if (!order || order.holdTokenHash !== sha(holdToken)) throw new NotFoundError("Booking not found");
    if (order.status !== "HELD" || !order.holdExpiresAt || order.holdExpiresAt <= this.now()) {
      throw new AppError(410, "HOLD_EXPIRED", "Your seats were released because time ran out — please pick them again.");
    }
    const event = await this.requireEvent(tenantId, order.eventId);
    return { order, event };
  }
  private async validPromo(tenantId: string, event: SeatEventRow, seatIds: string[], raw: string): Promise<PromoRule> {
    const code = raw.trim().toUpperCase();
    const row = code ? await this.repo.findPromoByCode(tenantId, code) : null;
    if (!row) throw new AppError(422, "PROMO_INVALID", "This code isn't valid.");
    const promo: PromoRule = { ...row, value: Number(row.value) };
    // كود لعرض معين بيشتغل على كل مواعيده
    const sameSeries = promo.eventId && event.seriesId && (await this.repo.findEvent(tenantId, promo.eventId))?.seriesId === event.seriesId;
    const problem = promoProblem(sameSeries ? { ...promo, eventId: event.id } : promo, event.id, this.now());
    if (problem) throw new AppError(422, "PROMO_INVALID", problem);
    if (!promoAppliesTo(readLayout(event.layout), seatIds, promo)) throw new AppError(422, "PROMO_INVALID", "This code isn't for the seats you picked.");
    return promo;
  }
  ticketInfo(order: SeatOrderRow, event: { title: string; startsAt: Date }, amountText: string | null): SeatTicketInfo {
    return {
      tenantId: order.tenantId,
      title: event.title,
      startsAt: event.startsAt,
      seats: order.seatIds.map(seatLabel),
      customerName: order.customerName ?? "",
      customerPhone: order.customerPhone ?? "",
      customerEmail: order.customerEmail,
      ticketCode: order.ticketCode,
      amountText,
    };
  }
  private async startsAt(tenantId: string, date: string, time: string) {
    const at = zonedDateTimeToUtc(date, time, await this.settings.timezone(tenantId));
    if (!at) throw new ValidationError("Please enter a valid date and time.");
    return at;
  }
  async requireEvent(tenantId: string, id: string) {
    const e = await this.repo.findEvent(tenantId, id);
    if (!e) throw new NotFoundError("Show not found");
    return e;
  }
  private async requireOrder(tenantId: string, id: string) {
    const o = await this.repo.findOrder(tenantId, id);
    if (!o) throw new NotFoundError("Booking not found");
    return o;
  }
  async notifyConfirmed(order: SeatOrderRow) {
    try {
      const event = await this.repo.findEvent(order.tenantId, order.eventId);
      if (!event) return;
      const pay = Number(order.amount) > 0 ? await this.payments.payable(order.tenantId, Number(order.amount)) : null;
      await this.notifier.confirmed(this.ticketInfo(order, event, pay ? `${pay.currency} ${pay.amount}` : null));
    } catch (err) {
      // الإشعار مايوقفش الحجز نفسه
      console.warn("[seats] confirmation notice failed:", (err as Error).message);
    }
  }
}

export function readLayoutSafe(value: unknown): SeatLayout | null {
  try {
    return readLayout(value);
  } catch {
    return null;
  }
}

export function isUniqueViolation(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}

// اللي بيرجع للعميل/التاجر (من غير hash التوكن)
export function publicOrder(o: SeatOrderRow) {
  const { holdTokenHash: _h, myFatoorahPaymentUrl: _u, ...rest } = o;
  return { ...rest, amount: Number(o.amount), subtotal: Number(o.subtotal), discount: Number(o.discount), reference: shortReference(o.id), seatLabels: o.seatIds.map(seatLabel) };
}
