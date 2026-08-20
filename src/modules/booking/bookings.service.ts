import { prisma } from "../../config/db";

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

// إنشاء حجز فعلي - الـ unique constraint على (resourceId, date, hour) بيمنع
// تعارض الحجز على مستوى قاعدة البيانات نفسها، مش بس فحص في الكود
export async function createBooking(input: CreateBookingInput) {
  const dayStart = new Date(input.date);
  dayStart.setHours(0, 0, 0, 0);

  try {
    return await prisma.booking.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        resourceId: input.resourceId,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        date: dayStart,
        hour: input.hour,
        note: input.note,
      },
      include: { resource: true },
    });
  } catch (err: any) {
    if (err.code === "P2002") {
      throw new Error("This slot was just booked by someone else — please pick another time");
    }
    throw err;
  }
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
