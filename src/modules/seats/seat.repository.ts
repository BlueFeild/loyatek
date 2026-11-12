import type { Prisma, PrismaClient } from "@prisma/client";

// كل كلام قاعدة البيانات الخاص بحجز الكراسي هنا (Prisma بس) - المنطق في seat-booking.service.ts
export const ACTIVE_ORDER = ["HELD", "AWAITING_PAYMENT", "CONFIRMED"] as const;

export type SeatOrderRow = Prisma.SeatOrderGetPayload<{}>;
export type SeatEventRow = Prisma.SeatEventGetPayload<{}>;

export class SeatRepository {
  constructor(private readonly db: PrismaClient) {}

  // ---------- القاعات ----------
  listVenues(tenantId: string) {
    return this.db.seatVenue.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  }
  findVenue(tenantId: string, id: string) {
    return this.db.seatVenue.findFirst({ where: { id, tenantId } });
  }
  createVenue(tenantId: string, name: string, layout: Prisma.InputJsonValue) {
    return this.db.seatVenue.create({ data: { tenantId, name, layout } });
  }
  async updateVenue(tenantId: string, id: string, data: { name?: string; layout?: Prisma.InputJsonValue }) {
    const r = await this.db.seatVenue.updateMany({ where: { id, tenantId }, data });
    return r.count ? this.findVenue(tenantId, id) : null;
  }
  async deleteVenue(tenantId: string, id: string) {
    const r = await this.db.seatVenue.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }

  // ---------- العروض ----------
  listEvents(tenantId: string) {
    return this.db.seatEvent.findMany({ where: { tenantId }, orderBy: { startsAt: "asc" }, include: { venue: { select: { name: true } } } });
  }
  findEvent(tenantId: string, id: string) {
    return this.db.seatEvent.findFirst({ where: { id, tenantId }, include: { venue: { select: { name: true } } } });
  }
  publicEvents(tenantId: string, now: Date) {
    return this.db.seatEvent.findMany({ where: { tenantId, status: "ON_SALE", startsAt: { gt: now } }, orderBy: { startsAt: "asc" }, take: 50, include: { venue: { select: { name: true } } } });
  }
  createEvent(data: Prisma.SeatEventUncheckedCreateInput) {
    return this.db.seatEvent.create({ data });
  }
  async updateEvent(tenantId: string, id: string, data: Prisma.SeatEventUncheckedUpdateManyInput) {
    const r = await this.db.seatEvent.updateMany({ where: { id, tenantId }, data });
    return r.count ? this.findEvent(tenantId, id) : null;
  }
  async deleteEvent(tenantId: string, id: string) {
    const r = await this.db.seatEvent.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }
  countActiveOrders(eventId: string) {
    return this.db.seatOrder.count({ where: { eventId, status: { in: ["AWAITING_PAYMENT", "CONFIRMED"] } } });
  }
  // أرقام كل عرض: كراسي اتباعت / متعلّقة + الإيراد (بالدولار)
  async eventStats(tenantId: string) {
    const rows = await this.db.seatOrder.findMany({
      where: { tenantId, status: { in: ["AWAITING_PAYMENT", "CONFIRMED"] } },
      select: { eventId: true, status: true, paymentStatus: true, amount: true, seatIds: true, checkedInAt: true },
    });
    const out = new Map<string, { sold: number; pending: number; revenue: number; checkedIn: number }>();
    for (const r of rows) {
      const s = out.get(r.eventId) ?? { sold: 0, pending: 0, revenue: 0, checkedIn: 0 };
      if (r.status === "CONFIRMED") s.sold += r.seatIds.length;
      else s.pending += r.seatIds.length;
      if (r.paymentStatus === "PAID" || r.paymentStatus === "NOT_REQUIRED") s.revenue += Number(r.amount);
      if (r.checkedInAt) s.checkedIn += r.seatIds.length;
      out.set(r.eventId, s);
    }
    return out;
  }

  // ---------- الحجز المؤقت والطلبات ----------
  // الحجوزات المؤقتة اللي وقتها خلص بتفك الكراسي
  async releaseExpired(eventId: string, now: Date) {
    await this.db.$transaction([
      this.db.seatOrder.updateMany({ where: { eventId, status: "HELD", holdExpiresAt: { lt: now } }, data: { status: "EXPIRED" } }),
      this.db.seatReservation.deleteMany({ where: { eventId, order: { status: { in: ["EXPIRED", "CANCELLED"] } } } }),
    ]);
  }
  async takenSeats(eventId: string) {
    const rows = await this.db.seatReservation.findMany({ where: { eventId }, select: { seatId: true } });
    return rows.map((r) => r.seatId);
  }
  // الكراسي المحجوزة مع حالة الطلب (للتاجر)
  reservationsWithOrders(eventId: string) {
    return this.db.seatReservation.findMany({ where: { eventId }, select: { seatId: true, order: { select: { id: true, status: true, customerName: true, paymentStatus: true, checkedInAt: true } } } });
  }

  // حجز مؤقت جديد في transaction: يلغي الحجز المؤقت القديم لنفس العميل (لو موجود)
  // ويحجز الكراسي. لو كرسي اتحجز في نفس اللحظة الـ unique بيرفض (P2002)
  async createHold(input: {
    tenantId: string;
    eventId: string;
    seatIds: string[];
    amount: number;
    holdTokenHash: string;
    holdExpiresAt: Date;
    ticketCode: string;
    replaceOrderId?: string;
    replaceTokenHash?: string;
  }) {
    return this.db.$transaction(async (tx) => {
      if (input.replaceOrderId && input.replaceTokenHash) {
        const r = await tx.seatOrder.updateMany({
          where: { id: input.replaceOrderId, eventId: input.eventId, status: "HELD", holdTokenHash: input.replaceTokenHash },
          data: { status: "CANCELLED" },
        });
        if (r.count) await tx.seatReservation.deleteMany({ where: { orderId: input.replaceOrderId } });
      }
      const order = await tx.seatOrder.create({
        data: {
          tenantId: input.tenantId,
          eventId: input.eventId,
          status: "HELD",
          seatIds: input.seatIds,
          amount: input.amount,
          holdTokenHash: input.holdTokenHash,
          holdExpiresAt: input.holdExpiresAt,
          ticketCode: input.ticketCode,
        },
      });
      await tx.seatReservation.createMany({ data: input.seatIds.map((seatId) => ({ tenantId: input.tenantId, eventId: input.eventId, orderId: order.id, seatId })) });
      return order;
    });
  }

  findOrder(tenantId: string, id: string) {
    return this.db.seatOrder.findFirst({ where: { id, tenantId } });
  }
  findOrderByTicket(ticketCode: string) {
    return this.db.seatOrder.findUnique({ where: { ticketCode }, include: { event: { include: { venue: { select: { name: true } } } } } });
  }
  findOrderByInvoice(tenantId: string, paymentId: string, notId: string) {
    return this.db.seatOrder.findFirst({ where: { tenantId, myFatoorahPaymentId: paymentId, id: { not: notId } } });
  }
  listOrders(tenantId: string, eventId: string) {
    return this.db.seatOrder.findMany({ where: { tenantId, eventId, status: { in: ["AWAITING_PAYMENT", "CONFIRMED", "CANCELLED"] } }, orderBy: { createdAt: "desc" }, take: 1000 });
  }

  // تغيير حالة طلب بشرط حالته الحالية (يمنع إن عمليتين يحصلوا على نفس الطلب)
  async transition(id: string, where: Prisma.SeatOrderWhereInput, data: Prisma.SeatOrderUncheckedUpdateManyInput) {
    const r = await this.db.seatOrder.updateMany({ where: { id, ...where }, data });
    if (!r.count) return null;
    return this.db.seatOrder.findUnique({ where: { id } });
  }

  // إلغاء طلب = الكراسي ترجع متاحة
  async cancelOrder(id: string, fromStatuses: string[]) {
    return this.db.$transaction(async (tx) => {
      const r = await tx.seatOrder.updateMany({ where: { id, status: { in: fromStatuses } }, data: { status: "CANCELLED", holdExpiresAt: null } });
      if (!r.count) return false;
      await tx.seatReservation.deleteMany({ where: { orderId: id } });
      return true;
    });
  }

  // تسجيل الدخول على الباب - مرة واحدة بس
  async checkIn(tenantId: string, ticketCode: string, at: Date) {
    const r = await this.db.seatOrder.updateMany({ where: { tenantId, ticketCode, status: "CONFIRMED", checkedInAt: null }, data: { checkedInAt: at } });
    return r.count > 0;
  }
}
