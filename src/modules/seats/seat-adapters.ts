import { prisma } from "../../config/db";
import { checkTenantMyFatoorahPaymentStatus, getTenantPaymentMethods, paymentInvoiceMatch, startTenantPayment } from "../checkout/myfatoorah";
import { getTenantMoney, payableAmount } from "../../utils/money";
import { getOrCreateWhatsappSettings, recordWhatsappMessage, sendWhatsappTextMessage } from "../whatsapp/whatsapp.service";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { utcToZonedParts } from "../../utils/timezone";
import type { SeatNotifier, SeatPayments, SeatSettingsReader, SeatTicketInfo } from "./seat-booking.service";

// توصيل خدمة الكراسي بالدفع الموجود (نفس طرق دفع التاجر في الحجز والمنيو)
export class TenantSeatPayments implements SeatPayments {
  methods(tenantId: string) {
    return getTenantPaymentMethods(tenantId);
  }
  async payable(tenantId: string, usd: number) {
    const money = await getTenantMoney(tenantId);
    return { amount: payableAmount(usd, money.currency, money.rates), currency: money.currency };
  }
  start(tenantId: string, method: Parameters<typeof startTenantPayment>[1], input: Parameters<typeof startTenantPayment>[2]) {
    return startTenantPayment(tenantId, method, input);
  }
  async check(tenantId: string, paymentId: string, invoiceId: string | null) {
    const r = await checkTenantMyFatoorahPaymentStatus(tenantId, paymentId);
    return r.paid && paymentInvoiceMatch(r.raw, invoiceId) !== "mismatch";
  }
}

export class BookingTimezoneReader implements SeatSettingsReader {
  async timezone(tenantId: string) {
    const s = await prisma.bookingSettings.findUnique({ where: { tenantId }, select: { timezone: true } });
    return s?.timezone || "Asia/Qatar";
  }
}

// التذكرة: إشعار للتاجر + رسالة واتساب للعميل فيها رابط التذكرة + إيميل لو كتبه
export class SeatTicketNotifier implements SeatNotifier {
  constructor(private readonly tz: SeatSettingsReader) {}

  async confirmed(info: SeatTicketInfo) {
    const tz = await this.tz.timezone(info.tenantId);
    const when = utcToZonedParts(info.startsAt, tz);
    const link = `${process.env.FRONTEND_BASE_URL || "http://localhost:5173"}/ticket/${info.ticketCode}`;
    const settings = await prisma.bookingSettings.findUnique({ where: { tenantId: info.tenantId }, select: { waTemplateLang: true, brandName: true } });
    const ar = settings?.waTemplateLang === "ar";
    const seats = info.seats.join(", ");
    const text = ar
      ? `🎟️ تذاكرك جاهزة يا ${info.customerName}\n${info.title}\n📅 ${when.date} - ${when.time}\n💺 الكراسي: ${seats}${info.amountText ? `\n💳 ${info.amountText}` : ""}\nاعرض الكود ده على الباب:\n${link}`
      : `🎟️ Your tickets are ready, ${info.customerName}\n${info.title}\n📅 ${when.date} at ${when.time}\n💺 Seats: ${seats}${info.amountText ? `\n💳 ${info.amountText}` : ""}\nShow this at the door:\n${link}`;

    await createNotification({ tenantId: info.tenantId, type: "BOOKING_CONFIRMED", title: "New tickets booked", body: `${info.customerName} booked ${info.seats.length} seat(s) for ${info.title} (${seats})`, link: "/booking?tab=seats" });

    try {
      const wa = await getOrCreateWhatsappSettings(info.tenantId);
      const to = info.customerPhone.replace(/[^\d]/g, "");
      // نص حر: Meta بتوصله بس لو العميل كلّم رقم الشركة في آخر 24 ساعة
      if (wa.isConnected && wa.metaAccessToken && wa.metaPhoneNumberId && to) {
        const r = await sendWhatsappTextMessage(wa.metaAccessToken, wa.metaPhoneNumberId, to, text);
        await recordWhatsappMessage({ tenantId: info.tenantId, direction: "OUT", contactPhone: to, contactName: info.customerName, body: text, kind: "text", waMessageId: r.messageId, status: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
      }
    } catch {
      // best effort
    }
    try {
      if (isValidEmail(info.customerEmail)) await sendEmail(info.customerEmail, `Your tickets — ${info.title}`, text);
    } catch {
      // best effort
    }
  }
}
