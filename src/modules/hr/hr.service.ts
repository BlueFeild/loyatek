import { prisma } from "../../config/db";

// حساب مكافأة نهاية الخدمة الحقيقي: الراتب اليومي (الراتب الأساسي
// الشهري ÷ 30) × عدد أيام المكافأة لكل سنة (اللي الشركة حدّدته) ×
// سنوات الخدمة الفعلية (من تاريخ التعيين لحد تاريخ الانتهاء أو
// النهارده). القانون في معظم دول الخليج بيشترط سنة خدمة كاملة على
// الأقل قبل استحقاق أي مكافأة - فبيرجّع صفر بصراحة لو أقل من سنة
export async function computeGratuity(tenantId: string, employeeId: string) {
  const [tenant, employee] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId } }),
    prisma.employee.findFirst({ where: { id: employeeId, tenantId } }),
  ]);
  if (!tenant || !employee) return null;

  const endDate = employee.terminationDate ?? new Date();
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const yearsOfService = (endDate.getTime() - employee.hireDate.getTime()) / msPerYear;

  if (yearsOfService < 1) {
    return {
      eligible: false,
      yearsOfService: Math.max(0, Math.round(yearsOfService * 100) / 100),
      gratuityAmount: 0,
      reason: "Less than 1 full year of service — not yet eligible under standard GCC end-of-service rules.",
    };
  }

  const dailyWage = Number(employee.baseSalary) / 30;
  const gratuityAmount = Math.round(dailyWage * tenant.gratuityDaysPerYear * yearsOfService * 100) / 100;

  return {
    eligible: true,
    yearsOfService: Math.round(yearsOfService * 100) / 100,
    dailyWage: Math.round(dailyWage * 100) / 100,
    gratuityDaysPerYear: tenant.gratuityDaysPerYear,
    gratuityAmount,
  };
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function startOfNextMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// المبيعات الفعلية للموظف في الشهر الحالي - مبنية على جدول Sale الحقيقي، مش تقدير
export async function getActualThisMonth(tenantId: string, employeeId: string) {
  const now = new Date();
  const sales = await prisma.sale.findMany({
    where: {
      tenantId,
      employeeId,
      createdAt: { gte: startOfMonth(now), lt: startOfNextMonth(now) },
    },
  });
  return sales.reduce((sum: number, s: { totalAmount: unknown }) => sum + Number(s.totalAmount), 0);
}

// نسبة الحضور: من إجمالي أيام المناوبة المجدولة (مش OFF) لغاية النهاردة في الشهر ده،
// كام يوم فعليًا كان فيه سجل حضور (ON_SHIFT أو BREAK). لو مفيش مناوبات مجدولة أصلاً
// بيرجع null بدل ما يورّي رقم مضلل زي 0% أو 100%.
export async function getAttendancePct(tenantId: string, employeeId: string): Promise<number | null> {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const today = startOfDay(now);

  const [shifts, attendanceRecords] = await Promise.all([
    prisma.shift.findMany({
      where: { tenantId, employeeId, date: { gte: monthStart, lte: today }, type: { not: "OFF" } },
    }),
    prisma.attendance.findMany({
      where: { tenantId, employeeId, date: { gte: monthStart, lte: today } },
    }),
  ]);

  if (shifts.length === 0) return null;

  const presentDates = new Set(
    attendanceRecords
      .filter((a: { status: string }) => a.status === "ON_SHIFT" || a.status === "BREAK")
      .map((a: { date: Date }) => new Date(a.date).toDateString())
  );

  const presentCount = shifts.filter((s: { date: Date }) => presentDates.has(new Date(s.date).toDateString())).length;

  return Math.round((presentCount / shifts.length) * 100);
}

export async function enrichEmployee(tenantId: string, employee: { id: string; monthlyTarget: unknown }) {
  const [actual, attendancePct] = await Promise.all([
    getActualThisMonth(tenantId, employee.id),
    getAttendancePct(tenantId, employee.id),
  ]);
  return { actual, target: Number(employee.monthlyTarget), attendancePct };
}

// إنشاء أو تحديث مناوبة يوم معيّن لموظف - يوم واحد بس لكل موظف، لو اتسجل تاني بيتحدث
export async function upsertShift(tenantId: string, employeeId: string, date: Date, type: "AM" | "PM" | "FULL" | "OFF") {
  return prisma.shift.upsert({
    where: { employeeId_date: { employeeId, date: startOfDay(date) } },
    update: { type },
    create: { tenantId, employeeId, date: startOfDay(date), type },
  });
}

// تسجيل حالة الحضور الفعلية ليوم معيّن (افتراضيًا النهاردة)
export async function upsertAttendance(
  tenantId: string,
  employeeId: string,
  date: Date,
  status: "ON_SHIFT" | "BREAK" | "OFF" | "ABSENT"
) {
  return prisma.attendance.upsert({
    where: { employeeId_date: { employeeId, date: startOfDay(date) } },
    update: { status },
    create: { tenantId, employeeId, date: startOfDay(date), status },
  });
}

export function getWeekDates(weekStart: Date): Date[] {
  const start = startOfDay(weekStart);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}
