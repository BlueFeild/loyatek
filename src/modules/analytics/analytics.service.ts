import { prisma } from "../../config/db";

// بيسجّل حدث حقيقي على مستوى المنصة (زيارة صفحة / تسجيل شركة / تسجيل
// دخول) - بيبلع أي خطأ عشان تتبع الأحداث الإحصائي ميوقّفش أي فلو حقيقي
// للمستخدم (زي التسجيل أو الدخول) لو فشل الـ insert لأي سبب
export async function trackPlatformEvent(input: {
  type: "PAGE_VIEW" | "SIGNUP" | "LOGIN";
  path?: string;
  tenantId?: string;
}) {
  try {
    await prisma.platformEvent.create({
      data: { type: input.type, path: input.path, tenantId: input.tenantId },
    });
  } catch {
    // silent - إحصائيات مش لازم توقف حاجة حقيقية
  }
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d: Date) {
  return startOfDay(d).toISOString().slice(0, 10);
}

// بيبني سلسلة أيام حقيقية بعدد صفر للأيام اللي مفيهاش أحداث - عشان
// الرسم البياني يبان متصل صح من غير فجوات
function lastNDays(n: number): string[] {
  const days: string[] = [];
  const today = startOfDay(new Date());
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  return days;
}

export async function getPlatformAnalytics() {
  const days = lastNDays(30);
  const since = new Date(days[0]);

  const [events, orders, tenants] = await Promise.all([
    prisma.platformEvent.findMany({ where: { createdAt: { gte: since } } }),
    prisma.subscriptionOrder.findMany(),
    prisma.tenant.count(),
  ]);

  function seriesFor(type: "PAGE_VIEW" | "SIGNUP" | "LOGIN") {
    const byDay: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
    for (const e of events) {
      if (e.type !== type) continue;
      const k = dayKey(e.createdAt);
      if (k in byDay) byDay[k] += 1;
    }
    return days.map((d) => ({ date: d, count: byDay[d] }));
  }

  const revenueOrders = orders.filter((o: any) => o.status === "ACTIVATED" || o.status === "PAID");
  const revenueByDay: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  for (const o of revenueOrders) {
    const k = dayKey(o.createdAt);
    if (k in revenueByDay) revenueByDay[k] += Number(o.amount);
  }

  const totalRevenue = revenueOrders.reduce((sum: number, o: any) => sum + Number(o.amount), 0);
  const activatedRevenue = orders
    .filter((o: any) => o.status === "ACTIVATED")
    .reduce((sum: number, o: any) => sum + Number(o.amount), 0);

  const visitEvents = events.filter((e: any) => e.type === "PAGE_VIEW");
  const signupEvents = events.filter((e: any) => e.type === "SIGNUP");
  const loginEvents = events.filter((e: any) => e.type === "LOGIN");

  const totalVisitsAllTime = await prisma.platformEvent.count({ where: { type: "PAGE_VIEW" } });
  const totalSignupsAllTime = await prisma.platformEvent.count({ where: { type: "SIGNUP" } });
  const totalLoginsAllTime = await prisma.platformEvent.count({ where: { type: "LOGIN" } });

  return {
    totals: {
      registeredCompanies: tenants,
      totalRevenue,
      activatedRevenue,
      ordersCount: orders.length,
      ordersByStatus: {
        PENDING: orders.filter((o: any) => o.status === "PENDING").length,
        PAID: orders.filter((o: any) => o.status === "PAID").length,
        ACTIVATED: orders.filter((o: any) => o.status === "ACTIVATED").length,
        CANCELLED: orders.filter((o: any) => o.status === "CANCELLED").length,
      },
      visitsLast30d: visitEvents.length,
      signupsLast30d: signupEvents.length,
      loginsLast30d: loginEvents.length,
      visitsAllTime: totalVisitsAllTime,
      signupsAllTime: totalSignupsAllTime,
      loginsAllTime: totalLoginsAllTime,
    },
    daily: {
      revenue: days.map((d) => ({ date: d, amount: revenueByDay[d] })),
      visits: seriesFor("PAGE_VIEW"),
      signups: seriesFor("SIGNUP"),
      logins: seriesFor("LOGIN"),
    },
  };
}
