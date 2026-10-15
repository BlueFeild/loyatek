import { prisma } from "../../config/db";
import { getOrCreateWhatsappSettings, recordWhatsappMessage, sendWhatsappTestMessage, sendWhatsappTextMessage } from "../whatsapp/whatsapp.service";
import { sendBookingTemplate, type TemplateLang } from "../whatsapp/booking-templates";
import { renderMessageTemplate } from "../../utils/messageTemplate";
import { createNotification } from "../notifications/notifications.service";
import { startTenantPayment, getTenantPaymentMethods, checkTenantMyFatoorahPaymentStatus, paymentInvoiceMatch } from "../checkout/myfatoorah";
import { confirmsOnOrder, pickPaymentMethod, shortReference, type PaymentMethod } from "../payment-settings/payment-methods";
import { formatCalendarDate, parseCalendarDate, todayCalendarDate } from "../../utils/calendarDate";
import { isValidEmail, sendEmail } from "../../utils/email";
import { getTenantMoney, payableAmount } from "../../utils/money";
import { computeBookingAmount, hasPricedServices } from "./service-pricing";

// إعدادات الحجز لكل شركة - بتتنشئ تلقائيًا بقيم افتراضية أول مرة
export async function getOrCreateSettings(tenantId: string) {
  const existing = await prisma.bookingSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.bookingSettings.create({ data: { tenantId } });
}

interface UpdateSettingsInput {
  industry?: string;
  brandName?: string;
  logoDataUrl?: string | null;
  services?: string[];
  servicePrices?: Record<string, number>;
  openHour?: number;
  closeHour?: number;
  disabledHours?: number[];
  slotDurationMin?: number;
  bufferMin?: number;
  peakFlag?: boolean;
  waAutomation?: boolean;
  waTemplate?: string;
  allocationMode?: string;
  themeColor?: string;
  paymentRequired?: boolean;
  paymentAmount?: number;
  merchantWhatsapp?: string;
  merchantEmail?: string;
  waMerchantTemplate?: string;
  askCustomerEmail?: boolean;
  waTemplateLang?: string;
  reminderEnabled?: boolean;
  reminderHoursBefore?: number;
  timezone?: string;
}

export async function updateSettings(tenantId: string, data: UpdateSettingsInput) {
  await getOrCreateSettings(tenantId); // يضمن وجود صف قبل التحديث
  return prisma.bookingSettings.update({ where: { tenantId }, data });
}

// الأماكن المتاحة فعليًا لمورد معيّن في يوم معيّن - بناءً على إعدادات
// ساعات العمل الحقيقية، مطروح منها الساعات المعطّلة والحجوزات
// الموجودة بالفعل. مش قائمة ثابتة.
export async function getAvailableSlots(tenantId: string, resourceId: string, date: string | Date) {
  const settings = await getOrCreateSettings(tenantId);

  const dayStart = requireCalendarDate(date);

  const existingBookings = await prisma.booking.findMany({
    where: { tenantId, resourceId, date: dayStart, status: { not: "CANCELLED" } },
  });
  const takenHours = new Set(existingBookings.map((b: { hour: number }) => b.hour));

  const disabled = new Set(settings.disabledHours);
  const slots: { hour: number; available: boolean }[] = [];
  for (let h = settings.openHour; h < settings.closeHour; h++) {
    if (disabled.has(h)) continue;
    slots.push({ hour: h, available: !takenHours.has(h) });
  }
  return slots;
}

interface CreateBookingInput {
  tenantId: string;
  branchId: string;
  resourceId: string;
  customerName: string;
  customerPhone: string;
  // يوم الحجز "YYYY-MM-DD" (يوم تقويم - شوفي utils/calendarDate.ts)
  date: string | Date;
  hour: number;
  note?: string;
  // إيميل العميل (اختياري) - بيوصله تأكيد الحجز بالإيميل لو Resend متظبط
  customerEmail?: string;
  // الخدمات اللي العميل اختارها (أسماء من إعدادات الحجز)
  services?: string[];
}

function requireCalendarDate(value: string | Date) {
  const day = parseCalendarDate(value);
  if (!day) throw new Error("Invalid date — please pick a day again");
  return day;
}

// خطوات "تأكيد" الحجز الحقيقية - واتساب + إشعار داخلي. بتتنفّذ فورًا
// لو الدفع مش مفعّل، أو بس بعد ما الدفع يتأكد فعليًا لو مفعّل - عشان
// التاجر ميتاكدش من حجز حد لسه ما دفعش
async function runBookingConfirmationSideEffects(
  booking: { id: string; resourceId: string; customerName: string; customerPhone: string; customerEmail?: string | null; paymentMethodLabel?: string | null; date: Date; hour: number; services?: string[] },
  tenantId: string,
  resourceName: string
) {
  let whatsappConfirmationSent = false;
  const bookingSettings = await getOrCreateSettings(tenantId);
  const vars = {
    name: booking.customerName,
    phone: booking.customerPhone,
    resource: resourceName,
    date: formatCalendarDate(booking.date),
    time: `${String(booking.hour).padStart(2, "0")}:00`,
    payment: booking.paymentMethodLabel ?? "—",
    // Meta مابتقبلش متغير فاضي في القالب
    services: (booking.services ?? []).join(", ") || "Appointment",
    business: bookingSettings.brandName,
    reference: shortReference(booking.id),
  };
  const digits = (v: string) => v.replace(/[^\d]/g, "");
  const lang: TemplateLang = bookingSettings.waTemplateLang === "ar" ? "ar" : "en";
  const templateValues = { ...vars };
  // نص حر + تسجيله في Team Inbox
  async function sendText(to: string, text: string, contactName?: string) {
    const r = await sendWhatsappTextMessage(waSettings.metaAccessToken!, waSettings.metaPhoneNumberId!, to, text);
    await recordWhatsappMessage({ tenantId, direction: "OUT", contactPhone: to, contactName, body: text, kind: "text", waMessageId: r.messageId, status: r.ok ? "sent" : "failed", error: r.ok ? null : r.error });
    return r;
  }
  const waSettings = await getOrCreateWhatsappSettings(tenantId);
  try {
    const waReady = waSettings.isConnected && waSettings.metaAccessToken && waSettings.metaPhoneNumberId;
    if (bookingSettings.waAutomation && waReady) {
      const phone = digits(booking.customerPhone);
      // 1) القالب المعتمد (بيوصل لأي رقم). 2) لو لسه مش معتمد: رسالة التاجر
      // كنص حر (بتوصل بس جوه نافذة الـ24 ساعة). 3) آخر حل: hello_world
      let result = await sendBookingTemplate(tenantId, "BOOKING_CONFIRMATION", lang, phone, templateValues, booking.customerName);
      if (!result?.ok) result = await sendText(phone, renderMessageTemplate(bookingSettings.waTemplate, vars), booking.customerName);
      if (!result.ok) result = await sendWhatsappTestMessage(waSettings.metaAccessToken!, waSettings.metaPhoneNumberId!, phone);
      whatsappConfirmationSent = result.ok;
    }
    // إشعار واتساب للتاجر نفسه (رقمه هو) بكل حجز جديد: القالب المعتمد
    // BOOKING_MERCHANT_ALERT لو موجود، وإلا نص حر (جوه نافذة الـ24 ساعة بس)
    if (waReady && digits(bookingSettings.merchantWhatsapp)) {
      const to = digits(bookingSettings.merchantWhatsapp);
      let result = await sendBookingTemplate(tenantId, "BOOKING_MERCHANT_ALERT", lang, to, templateValues);
      if (!result?.ok && bookingSettings.waMerchantTemplate.trim()) result = await sendText(to, renderMessageTemplate(bookingSettings.waMerchantTemplate, vars));
      if (result && !result.ok) console.warn(`[booking] merchant WhatsApp notification not delivered for tenant ${tenantId}: ${result.error}`);
    }
  } catch {
    // فشل الإرسال ميوقفش نجاح الحجز نفسه - ده feature إضافي مش أساسي
  }

  // إيميلات (لو Resend متظبط في Railway): للتاجر بكل حجز، وللعميل لو كتب إيميله
  try {
    const when = `${vars.date} at ${vars.time}`;
    if (isValidEmail(bookingSettings.merchantEmail)) {
      await sendEmail(
        bookingSettings.merchantEmail,
        `New booking — ${booking.customerName}, ${when}`,
        renderMessageTemplate(bookingSettings.waMerchantTemplate, vars) || `New booking: ${booking.customerName} (${booking.customerPhone}) — ${vars.services} with ${resourceName}, ${when} (ref ${vars.reference})`
      );
    }
    if (isValidEmail(booking.customerEmail)) {
      await sendEmail(
        booking.customerEmail,
        `Booking confirmed — ${vars.services} at ${bookingSettings.brandName}, ${when}`,
        renderMessageTemplate(bookingSettings.waTemplate, vars) || `Your booking at ${bookingSettings.brandName} is confirmed for ${when}.`
      );
    }
  } catch {
    // best effort
  }

  await createNotification({
    tenantId,
    type: "BOOKING_CONFIRMED",
    title: "New booking confirmed",
    body: `${booking.customerName} booked ${resourceName} on ${formatCalendarDate(booking.date)} at ${booking.hour}:00`,
    link: "/booking",
  });

  return whatsappConfirmationSent;
}

// إنشاء حجز فعلي - الـ unique constraint على (resourceId, date, hour) بيمنع
// تعارض الحجز على مستوى قاعدة البيانات نفسها، مش بس فحص في الكود.
// redirectionUrlBase من غير أي query params - بنضيف bookingId بعد ما
// الحجز يتحفظ فعليًا ونعرف الـ id بتاعه
export async function createBooking(input: CreateBookingInput & { redirectionUrlBase?: string; paymentMethodId?: string }) {
  const dayStart = requireCalendarDate(input.date);

  const settings = await getOrCreateSettings(input.tenantId);
  // المبلغ = مجموع أسعار الخدمات اللي اختارها (من الأسعار المحفوظة)، أو
  // المبلغ الثابت لو مفيش خدمات بسعر
  const pricing = computeBookingAmount(settings, input.services);
  if (settings.paymentRequired && hasPricedServices(settings.servicePrices, settings.services) && pricing.services.length === 0) {
    throw new Error("Please choose at least one service.");
  }
  const amount = pricing.amount;
  // الدفع مفعّل بمبلغ صفر = مفيش حاجة تتدفع، فبيتعامل كحجز مجاني عادي
  const paymentOn = settings.paymentRequired && amount > 0;

  // بنختار طريقة الدفع قبل ما نحجز المكان - عشان اختيار غلط مايسيبش
  // ميعاد محجوز من غير ما حد يقدر يدفع
  let method: PaymentMethod | null = null;
  if (paymentOn) {
    const methods = await getTenantPaymentMethods(input.tenantId);
    if (methods.length === 0) throw new Error("This business hasn't set up a payment method yet.");
    method = pickPaymentMethod(methods, input.paymentMethodId);
    if (!method) throw new Error("Please choose one of the available payment methods.");
  }

  let booking;
  try {
    booking = await prisma.booking.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        resourceId: input.resourceId,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerEmail: isValidEmail(input.customerEmail) ? input.customerEmail.trim() : null,
        date: dayStart,
        hour: input.hour,
        note: input.note,
        services: pricing.services,
        paymentStatus: paymentOn ? "AWAITING_PAYMENT" : "NOT_REQUIRED",
        amount: paymentOn ? amount : null,
        paymentMethodType: method?.type ?? null,
        paymentMethodLabel: method?.label ?? null,
      },
      include: { resource: true },
    });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      throw new Error("This slot was just booked by someone else — please pick another time");
    }
    throw err;
  }

  // من غير دفع - نفس السلوك القديم بالظبط، تأكيد فوري
  if (!paymentOn || !method) {
    const whatsappConfirmationSent = await runBookingConfirmationSideEffects(booking, input.tenantId, booking.resource.name);
    return { ...booking, whatsappConfirmationSent, paymentUrl: null, paymentError: null, paymentInstructions: null };
  }

  // المبلغ متخزن بالدولار - العميل بيدفع بعملة الشركة بسعر الصرف الحالي
  const money = await getTenantMoney(input.tenantId);
  const payAmount = payableAmount(amount, money.currency, money.rates);
  const paymentInstructions = { type: method.type, label: method.label, details: method.details ?? null, amount: payAmount, currency: money.currency, reference: shortReference(booking.id) };

  // كاش عند الوصول: الميعاد بيتأكد فورًا (واتساب + إشعار)، والفلوس
  // بتتدفع في المكان - التاجر يدوس "Mark paid" لما يستلم
  if (confirmsOnOrder(method.type)) {
    const whatsappConfirmationSent = await runBookingConfirmationSideEffects(booking, input.tenantId, booking.resource.name);
    return { ...booking, whatsappConfirmationSent, paymentUrl: null, paymentError: null, paymentInstructions };
  }

  // تحويل بنكي: الميعاد محجوز بحالة AWAITING_PAYMENT، والعميل بيشوف
  // بيانات التحويل. بيتأكد لما التاجر يدوس "Mark paid"
  if (method.type === "BANK_TRANSFER") {
    return { ...booking, whatsappConfirmationSent: false, paymentUrl: null, paymentError: null, paymentInstructions };
  }

  // MyFatoorah أو لينك دفع - الحجز محفوظ فعليًا بحالة AWAITING_PAYMENT
  // (المكان محجوز فعليًا بفضل الـ unique constraint)، وبيتأكد بس بعد
  // ما الدفع ينجح (MyFatoorah تلقائي / اللينك بـ "Mark paid")
  const payment = await startTenantPayment(input.tenantId, method, {
    amount: payAmount,
    redirectionUrl: `${input.redirectionUrlBase ?? ""}?bookingId=${booking.id}`,
    reference: booking.id,
  });

  if (!payment.ok) {
    return { ...booking, whatsappConfirmationSent: false, paymentUrl: null, paymentError: payment.error, paymentInstructions: null };
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
    include: { resource: true },
  });

  return { ...updated, whatsappConfirmationSent: false, paymentUrl: payment.paymentUrl, paymentError: null, paymentInstructions: null };
}

// بيتأكد من حالة دفع حجز حقيقي بالسؤال المباشر لـ MyFatoorah (بمفتاح
// التاجر نفسه)، ولو الدفع نجح فعليًا بيأكّد الحجز (واتساب + إشعار) -
// أول مرة بس، مش في كل استعلام
export async function confirmBookingPaymentIfPaid(bookingId: string, paymentId: string) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { resource: true } });
  if (!booking) throw new Error("Booking not found");

  if (booking.paymentStatus === "PAID") return { ...booking, whatsappConfirmationSent: false };
  if (booking.paymentStatus !== "AWAITING_PAYMENT") return { ...booking, whatsappConfirmationSent: false };

  const check = await checkTenantMyFatoorahPaymentStatus(booking.tenantId, paymentId);
  if (!check.paid) return { ...booking, whatsappConfirmationSent: false };
  // الدفعة لازم تخص فاتورة الحجز ده، ومتكونش اتستخدمت لحجز تاني قبل كده
  if (paymentInvoiceMatch(check.raw, booking.myFatoorahInvoiceId) === "mismatch") return { ...booking, whatsappConfirmationSent: false };
  const reused = await prisma.booking.findFirst({ where: { myFatoorahPaymentId: paymentId, id: { not: booking.id } } });
  if (reused) return { ...booking, whatsappConfirmationSent: false };

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { paymentStatus: "PAID", myFatoorahPaymentId: paymentId },
    include: { resource: true },
  });

  const whatsappConfirmationSent = await runBookingConfirmationSideEffects(updated, updated.tenantId, updated.resource.name);
  return { ...updated, whatsappConfirmationSent };
}

// التاجر بيأكد يدويًا إن العميل دفع (لو بيستخدم لينك دفع من مزوّد تاني)
export async function markBookingPaidManually(tenantId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenantId }, include: { resource: true } });
  if (!booking) throw new Error("Booking not found");
  if (booking.paymentStatus === "PAID") return { ...booking, whatsappConfirmationSent: false };
  if (booking.paymentStatus !== "AWAITING_PAYMENT") throw new Error("This booking isn't waiting for payment");
  const updated = await prisma.booking.update({ where: { id: booking.id }, data: { paymentStatus: "PAID" }, include: { resource: true } });
  // حجز الكاش اتأكد خلاص وقت الحجز (واتساب اتبعت) - مانبعتش تاني
  if (confirmsOnOrder(booking.paymentMethodType)) return { ...updated, whatsappConfirmationSent: false };
  const whatsappConfirmationSent = await runBookingConfirmationSideEffects(updated, updated.tenantId, updated.resource.name);
  return { ...updated, whatsappConfirmationSent };
}

export async function cancelBooking(tenantId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenantId } });
  if (!booking) throw new Error("Booking not found");
  return prisma.booking.update({ where: { id: bookingId }, data: { status: "CANCELLED" } });
}

export async function rescheduleBooking(tenantId: string, bookingId: string, newDate: string | Date, newHour: number) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenantId } });
  if (!booking) throw new Error("Booking not found");

  const dayStart = requireCalendarDate(newDate);

  try {
    return await prisma.booking.update({
      where: { id: bookingId },
      data: { date: dayStart, hour: newHour },
      include: { resource: true },
    });
  } catch (err: any) {
    if (err.code === "P2002") {
      throw new Error("This slot is already taken — please pick another time");
    }
    throw err;
  }
}

// إحصائيات حقيقية - عدد حجوزات الأسبوع، عدد حجوزات النهاردة، ونسبة
// استغلال الموارد (كام ساعة فعليًا اتحجزت من إجمالي الساعات المتاحة)
export async function getBookingStats(tenantId: string, branchId: string) {
  const settings = await getOrCreateSettings(tenantId);

  // أيام تقويم UTC - نفس تمثيل عمود date في قاعدة البيانات
  const DAY = 24 * 60 * 60 * 1000;
  const todayStart = todayCalendarDate();
  const todayEnd = new Date(todayStart.getTime() + DAY);

  const weekStart = new Date(todayStart.getTime() - todayStart.getUTCDay() * DAY);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);

  const [bookingsThisWeek, bookingsToday, resources] = await Promise.all([
    prisma.booking.count({
      where: { tenantId, branchId, date: { gte: weekStart, lt: weekEnd }, status: { not: "CANCELLED" } },
    }),
    prisma.booking.count({
      where: { tenantId, branchId, date: { gte: todayStart, lt: todayEnd }, status: { not: "CANCELLED" } },
    }),
    prisma.resource.count({ where: { tenantId, branchId } }),
  ]);

  const hoursPerDay = Math.max(0, settings.closeHour - settings.openHour - settings.disabledHours.length);
  const totalWeeklyCapacity = hoursPerDay * 7 * Math.max(1, resources);
  const utilization = totalWeeklyCapacity > 0 ? Math.round((bookingsThisWeek / totalWeeklyCapacity) * 100) : 0;

  return {
    bookingsThisWeek,
    bookingsToday,
    resourceUtilizationPct: Math.min(100, utilization),
  };
}
