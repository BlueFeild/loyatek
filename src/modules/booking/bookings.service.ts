import { prisma } from "../../config/db";
import { getOrCreateWhatsappSettings, sendWhatsappTestMessage } from "../whatsapp/whatsapp.service";
import { createNotification } from "../notifications/notifications.service";
import { initiateTenantMyFatoorahPayment, checkTenantMyFatoorahPaymentStatus } from "../checkout/myfatoorah";

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
}

export async function updateSettings(tenantId: string, data: UpdateSettingsInput) {
  await getOrCreateSettings(tenantId); // يضمن وجود صف قبل التحديث
  return prisma.bookingSettings.update({ where: { tenantId }, data });
}

// الأماكن المتاحة فعليًا لمورد معيّن في يوم معيّن - بناءً على إعدادات
// ساعات العمل الحقيقية، مطروح منها الساعات المعطّلة والحجوزات
// الموجودة بالفعل. مش قائمة ثابتة.
export async function getAvailableSlots(tenantId: string, resourceId: string, date: Date) {
  const settings = await getOrCreateSettings(tenantId);

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

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
  date: Date;
  hour: number;
  note?: string;
}

// خطوات "تأكيد" الحجز الحقيقية - واتساب + إشعار داخلي. بتتنفّذ فورًا
// لو الدفع مش مفعّل، أو بس بعد ما الدفع يتأكد فعليًا لو مفعّل - عشان
// التاجر ميتاكدش من حجز حد لسه ما دفعش
async function runBookingConfirmationSideEffects(booking: { id: string; resourceId: string; customerName: string; customerPhone: string; date: Date; hour: number; }, tenantId: string, resourceName: string) {
  let whatsappConfirmationSent = false;
  try {
    const bookingSettings = await getOrCreateSettings(tenantId);
    if (bookingSettings.waAutomation) {
      const waSettings = await getOrCreateWhatsappSettings(tenantId);
      if (waSettings.isConnected && waSettings.metaAccessToken && waSettings.metaPhoneNumberId) {
        const phone = booking.customerPhone.replace(/[^\d]/g, "");
        const result = await sendWhatsappTestMessage(waSettings.metaAccessToken, waSettings.metaPhoneNumberId, phone);
        whatsappConfirmationSent = result.ok;
      }
    }
  } catch {
    // فشل الإرسال ميوقفش نجاح الحجز نفسه - ده feature إضافي مش أساسي
  }

  await createNotification({
    tenantId,
    type: "BOOKING_CONFIRMED",
    title: "New booking confirmed",
    body: `${booking.customerName} booked ${resourceName} on ${booking.date.toLocaleDateString()} at ${booking.hour}:00`,
    link: "/booking",
  });

  return whatsappConfirmationSent;
}

// إنشاء حجز فعلي - الـ unique constraint على (resourceId, date, hour) بيمنع
// تعارض الحجز على مستوى قاعدة البيانات نفسها، مش بس فحص في الكود.
// redirectionUrlBase من غير أي query params - بنضيف bookingId بعد ما
// الحجز يتحفظ فعليًا ونعرف الـ id بتاعه
export async function createBooking(input: CreateBookingInput & { redirectionUrlBase?: string }) {
  const dayStart = new Date(input.date);
  dayStart.setHours(0, 0, 0, 0);

  const settings = await getOrCreateSettings(input.tenantId);

  let booking;
  try {
    booking = await prisma.booking.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        resourceId: input.resourceId,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        date: dayStart,
        hour: input.hour,
        note: input.note,
        paymentStatus: settings.paymentRequired ? "AWAITING_PAYMENT" : "NOT_REQUIRED",
        amount: settings.paymentRequired ? settings.paymentAmount : null,
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
  if (!settings.paymentRequired) {
    const whatsappConfirmationSent = await runBookingConfirmationSideEffects(booking, input.tenantId, booking.resource.name);
    return { ...booking, whatsappConfirmationSent, paymentUrl: null, paymentError: null };
  }

  // الدفع مفعّل - الحجز محفوظ فعليًا بحالة AWAITING_PAYMENT (المكان
  // محجوز فعليًا بفضل الـ unique constraint)، وبيتأكد فعليًا بس بعد
  // ما الدفع الحقيقي ينجح (شوفي confirmBookingPaymentIfPaid تحت)
  const payment = await initiateTenantMyFatoorahPayment(input.tenantId, {
    amount: Number(settings.paymentAmount),
    redirectionUrl: `${input.redirectionUrlBase ?? ""}?bookingId=${booking.id}`,
  });

  if (!payment.ok) {
    return { ...booking, whatsappConfirmationSent: false, paymentUrl: null, paymentError: payment.error };
  }

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
    include: { resource: true },
  });

  return { ...updated, whatsappConfirmationSent: false, paymentUrl: payment.paymentUrl, paymentError: null };
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

  const updated = await prisma.booking.update({
    where: { id: booking.id },
    data: { paymentStatus: "PAID", myFatoorahPaymentId: paymentId },
    include: { resource: true },
  });

  const whatsappConfirmationSent = await runBookingConfirmationSideEffects(updated, updated.tenantId, updated.resource.name);
  return { ...updated, whatsappConfirmationSent };
}

export async function cancelBooking(tenantId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenantId } });
  if (!booking) throw new Error("Booking not found");
  return prisma.booking.update({ where: { id: bookingId }, data: { status: "CANCELLED" } });
}

export async function rescheduleBooking(tenantId: string, bookingId: string, newDate: Date, newHour: number) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, tenantId } });
  if (!booking) throw new Error("Booking not found");

  const dayStart = new Date(newDate);
  dayStart.setHours(0, 0, 0, 0);

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

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

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
