import crypto from "crypto";
import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { confirmsOnOrder, pickPaymentMethod, shortReference, type PaymentMethod } from "../payment-settings/payment-methods";
import { allSeats, applyEventLayoutChanges, layoutSchema, priceSeats, readLayout, seatLabel, SeatLayoutError, tierSchema, type SeatLayout } from "./seat-layout";
import { ACTIVE_ORDER, type SeatOrderRow, type SeatRepository } from "./seat.repository";
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
});
export const eventPatch = eventInput.omit({ venueId: true }).partial().extend({ tiers: z.array(tierSchema).optional(), blocked: z.array(z.string().max(12)).max(1500).optional() });

export const checkoutInput = z.object({
  holdToken: z.string().min(16).max(80),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().min(6).max(30),
  customerEmail: z.union([z.literal(""), z.string().trim().email().max(200)]).optional(),
  paymentMethodId: z.string().max(64).optional(),
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
    });
  }

  async updateEvent(tenantId: string, id: string, input: z.infer<typeof eventPatch>) {
    const event = await this.requireEvent(tenantId, id);
    const data: Record<string, unknown> = {};
    for (const k of ["title", "status", "maxPerOrder", "holdMinutes"] as const) if (input[k] !== undefined) data[k] = input[k];
    if (input.description !== undefined) data.description = input.description || null;
    if (input.imageDataUrl !== undefined) data.imageDataUrl = input.imageDataUrl || null;
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
    return events.map((e) => {
      const layout = readLayoutSafe(e.layout);
      const prices = layout ? layout.tiers.map((t) => t.price) : [];
      return { id: e.id, title: e.title, description: e.description, imageDataUrl: e.imageDataUrl, startsAt: e.startsAt, local: utcToZonedParts(e.startsAt, tz), venueName: e.venue?.name ?? null, fromPrice: prices.length ? Math.min(...prices) : 0 };
    });
  }

  async publicEvent(tenantId: string, id: string) {
    const event = await this.requireEvent(tenantId, id);
    if (event.status !== "ON_SALE") throw new NotFoundError("This show isn't on sale.");
    await this.repo.releaseExpired(id, this.now());
    const [taken, tz] = await Promise.all([this.repo.takenSeats(id), this.settings.timezone(tenantId)]);
    return {
      id: event.id,
      title: event.title,
      description: event.description,
      imageDataUrl: event.imageDataUrl,
      startsAt: event.startsAt,
      local: utcToZonedParts(event.startsAt, tz),
      timezone: tz,
      venueName: event.venue?.name ?? null,
      layout: readLayout(event.layout),
      taken,
      maxPerOrder: event.maxPerOrder,
      holdMinutes: event.holdMinutes,
      past: event.startsAt <= this.now(),
    };
  }

  // العميل اختار كراسي -> بتتحجز له مؤقتًا (holdMinutes) لحد ما يكمل بياناته
  async hold(tenantId: string, eventId: string, seatIds: string[], replace?: { orderId?: string; token?: string }) {
    const event = await this.requireEvent(tenantId, eventId);
    if (event.status !== "ON_SALE") throw new AppError(409, "NOT_ON_SALE", "Tickets for this show aren't on sale right now.");
    if (event.startsAt <= this.now()) throw new AppError(409, "EVENT_STARTED", "This show has already started.");
    if (seatIds.length < 1) throw new ValidationError("Please pick at least one seat.");
    if (seatIds.length > event.maxPerOrder) throw new ValidationError(`You can book up to ${event.maxPerOrder} seats at a time.`);
    let priced;
    try {
      priced = priceSeats(readLayout(event.layout), seatIds);
    } catch (e) {
      if (e instanceof SeatLayoutError) throw new ValidationError(e.message);
      throw e;
    }
    await this.repo.releaseExpired(eventId, this.now());
    const token = crypto.randomBytes(24).toString("hex");
    try {
      const order = await this.repo.createHold({
        tenantId,
        eventId,
        seatIds: priced.seats.map((s) => s.id),
        amount: priced.amount,
        holdTokenHash: sha(token),
        holdExpiresAt: new Date(this.now().getTime() + event.holdMinutes * 60000),
        ticketCode: newTicketCode(),
        replaceOrderId: replace?.orderId,
        replaceTokenHash: replace?.token ? sha(replace.token) : undefined,
      });
      return { orderId: order.id, holdToken: token, expiresAt: order.holdExpiresAt, amount: priced.amount, seats: order.seatIds };
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

  async checkout(tenantId: string, orderId: string, input: z.infer<typeof checkoutInput>, redirectionUrlBase: string) {
    const order = await this.repo.findOrder(tenantId, orderId);
    if (!order || order.holdTokenHash !== sha(input.holdToken)) throw new NotFoundError("Booking not found");
    if (order.status !== "HELD" || !order.holdExpiresAt || order.holdExpiresAt <= this.now()) {
      throw new AppError(410, "HOLD_EXPIRED", "Your seats were released because time ran out — please pick them again.");
    }
    const amount = Number(order.amount);
    const paymentOn = amount > 0;
    let method: PaymentMethod | null = null;
    if (paymentOn) {
      const methods = await this.payments.methods(tenantId);
      if (methods.length === 0) throw new AppError(409, "NO_PAYMENT_METHOD", "This business hasn't set up a payment method yet.");
      method = pickPaymentMethod(methods, input.paymentMethodId);
      if (!method) throw new ValidationError("Please choose one of the available payment methods.");
    }
    const confirmedNow = !paymentOn || (method !== null && confirmsOnOrder(method.type));
    const customer = { customerName: input.customerName, customerPhone: input.customerPhone, customerEmail: input.customerEmail || null };
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
    if (!updated) throw new AppError(410, "HOLD_EXPIRED", "Your seats were released because time ran out — please pick them again.");

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

  // ---------- مساعدات ----------
  private async startsAt(tenantId: string, date: string, time: string) {
    const at = zonedDateTimeToUtc(date, time, await this.settings.timezone(tenantId));
    if (!at) throw new ValidationError("Please enter a valid date and time.");
    return at;
  }
  private async requireEvent(tenantId: string, id: string) {
    const e = await this.repo.findEvent(tenantId, id);
    if (!e) throw new NotFoundError("Show not found");
    return e;
  }
  private async requireOrder(tenantId: string, id: string) {
    const o = await this.repo.findOrder(tenantId, id);
    if (!o) throw new NotFoundError("Booking not found");
    return o;
  }
  private async notifyConfirmed(order: SeatOrderRow) {
    try {
      const event = await this.repo.findEvent(order.tenantId, order.eventId);
      if (!event) return;
      const pay = Number(order.amount) > 0 ? await this.payments.payable(order.tenantId, Number(order.amount)) : null;
      await this.notifier.confirmed({
        tenantId: order.tenantId,
        title: event.title,
        startsAt: event.startsAt,
        seats: order.seatIds.map(seatLabel),
        customerName: order.customerName ?? "",
        customerPhone: order.customerPhone ?? "",
        customerEmail: order.customerEmail,
        ticketCode: order.ticketCode,
        amountText: pay ? `${pay.currency} ${pay.amount}` : null,
      });
    } catch (err) {
      // الإشعار مايوقفش الحجز نفسه
      console.warn("[seats] confirmation notice failed:", (err as Error).message);
    }
  }
}

function readLayoutSafe(value: unknown): SeatLayout | null {
  try {
    return readLayout(value);
  } catch {
    return null;
  }
}

function isUniqueViolation(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}

// اللي بيرجع للعميل/التاجر (من غير hash التوكن)
export function publicOrder(o: SeatOrderRow) {
  const { holdTokenHash: _h, myFatoorahPaymentUrl: _u, ...rest } = o;
  return { ...rest, amount: Number(o.amount), reference: shortReference(o.id), seatLabels: o.seatIds.map(seatLabel) };
}
