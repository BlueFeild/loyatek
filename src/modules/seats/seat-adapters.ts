import { prisma } from "../../config/db";
import { checkTenantMyFatoorahPaymentStatus, getTenantPaymentMethods, paymentInvoiceMatch, startTenantPayment } from "../checkout/myfatoorah";
import { getTenantMoney, payableAmount } from "../../utils/money";
import { getOrCreateWhatsappSettings, recordWhatsappMessage, sendWhatsappTextMessage } from "../whatsapp/whatsapp.service";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { isValidTimeZone, utcToZonedParts } from "../../utils/timezone";
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

// إعدادات صفحة التذاكر: إعدادات التذاكر الأول، ولو مش موجودة بنستخدم إعدادات الحجز (الشركات
// اللي بدأت التذاكر وهي جوه الحجز)، وإلا اسم الشركة
export class SeatSettingsStore implements SeatSettingsReader {
  async timezone(tenantId: string) {
    const [own, booking] = await Promise.all([
      prisma.seatSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
      prisma.bookingSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    ]);
    const tz = own?.timezone || booking?.timezone;
    return tz && isValidTimeZone(tz) ? tz : "Asia/Qatar";
  }

  async brand(tenantId: string) {
    const [tenant, own, booking] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } }),
      prisma.seatSettings.findUnique({ where: { tenantId } }),
      prisma.bookingSettings.findUnique({ where: { tenantId }, select: { brandName: true, logoDataUrl: true, themeColor: true, waTemplateLang: true } }),
    ]);
    return {
      name: own?.brandName || booking?.brandName || tenant?.name || "",
      logoDataUrl: own?.logoDataUrl ?? booking?.logoDataUrl ?? null,
      color: own?.accentColor || null,
      slug: tenant?.slug ?? null,
      // شكل الصفحة العامة
      template: own?.pageTemplate ?? "bluefield",
      style: own?.pageStyle ?? null,
      coverDataUrl: own?.coverDataUrl ?? null,
      lang: booking?.waTemplateLang === "ar" ? ("ar" as const) : ("en" as const),
    };
  }
}

const frontendBase = () => process.env.FRONTEND_BASE_URL || "http://localhost:5173";

// التذكرة: إشعار للتاجر + رسالة واتساب للعميل فيها رابط التذكرة + إيميل لو كتبه
export class SeatTicketNotifier implements SeatNotifier {
  constructor(private readonly store: SeatSettingsStore) {}

  async confirmed(info: SeatTicketInfo) {
    const [tz, brand] = await Promise.all([this.store.timezone(info.tenantId), this.store.brand(info.tenantId)]);
    const when = utcToZonedParts(info.startsAt, tz);
    const link = `${frontendBase()}/ticket/${info.ticketCode}`;
    const seats = info.seats.join(", ");
    const text = brand.lang === "ar"
      ? `🎟️ تذاكرك جاهزة يا ${info.customerName}\n${info.title}\n📅 ${when.date} - ${when.time}\n💺 الكراسي: ${seats}${info.amountText ? `\n💳 ${info.amountText}` : ""}\nاعرض الكود ده على الباب:\n${link}`
      : `🎟️ Your tickets are ready, ${info.customerName}\n${info.title}\n📅 ${when.date} at ${when.time}\n💺 Seats: ${seats}${info.amountText ? `\n💳 ${info.amountText}` : ""}\nShow this at the door:\n${link}`;

    await createNotification({ tenantId: info.tenantId, type: "BOOKING_CONFIRMED", title: "New tickets booked", body: `${info.customerName} booked ${info.seats.length} seat(s) for ${info.title} (${seats})`, link: "/tickets" });
    await this.send(info.tenantId, info.customerPhone, info.customerName, text);
    await this.mail(info.customerEmail, `Your tickets — ${info.title}`, text);
  }

  async reminder(info: SeatTicketInfo) {
    const [tz, brand] = await Promise.all([this.store.timezone(info.tenantId), this.store.brand(info.tenantId)]);
    const when = utcToZonedParts(info.startsAt, tz);
    const link = `${frontendBase()}/ticket/${info.ticketCode}`;
    const seats = info.seats.join(", ");
    const text = brand.lang === "ar"
      ? `⏰ تذكير يا ${info.customerName}: ${info.title}\n📅 ${when.date} - ${when.time}\n💺 ${seats}\nتذكرتك:\n${link}`
      : `⏰ Reminder, ${info.customerName}: ${info.title}\n📅 ${when.date} at ${when.time}\n💺 ${seats}\nYour ticket:\n${link}`;
    const wa = await this.send(info.tenantId, info.customerPhone, info.customerName, text);
    const mail = await this.mail(info.customerEmail, `Reminder — ${info.title}`, text);
    return wa || mail;
  }

  async waitlistOpen(info: { tenantId: string; eventId: string; title: string; startsAt: Date; name: string; phone: string; email: string | null }) {
    const [tz, brand] = await Promise.all([this.store.timezone(info.tenantId), this.store.brand(info.tenantId)]);
    const when = utcToZonedParts(info.startsAt, tz);
    const link = `${frontendBase()}/events/${brand.slug}/${info.eventId}`;
    const text = brand.lang === "ar"
      ? `🎉 خبر حلو يا ${info.name}! فيه كراسي فضيت في ${info.title} (${when.date} - ${when.time}).\nاحجز بسرعة قبل ما تخلص:\n${link}`
      : `🎉 Good news, ${info.name}! Seats just opened up for ${info.title} (${when.date} at ${when.time}).\nBook quickly before they go:\n${link}`;
    const wa = await this.send(info.tenantId, info.phone, info.name, text);
    const mail = await this.mail(info.email, `Seats available — ${info.title}`, text);
    return wa || mail;
  }

  // نص حر: Meta بتوصله بس لو العميل كلّم رقم الشركة في آخر 24 ساعة
  private async send(tenantId: string, phone: string, name: string, text: string) {
    try {
      const wa = await getOrCreateWhatsappSettings(tenantId);
      const to = phone.replace(/[^\d]/g, "");
      if (!(wa.isConnected && wa.metaAccessToken && wa.metaPhoneNumberId && to)) return false;
      const r = await sendWhatsappTextMessage(wa.metaAccessToken, wa.metaPhoneNumberId, to, text);
      await recordWhatsappMessage({ tenantId, direction: "OUT", contactPhone: to, contactName: name, body: text, kind: "text", waMessageId: r.messageId, status: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
      return r.ok;
    } catch {
      return false; // best effort
    }
  }

  private async mail(to: string | null, subject: string, text: string) {
    try {
      if (!isValidEmail(to)) return false;
      return (await sendEmail(to, subject, text)).ok;
    } catch {
      return false;
    }
  }
}
