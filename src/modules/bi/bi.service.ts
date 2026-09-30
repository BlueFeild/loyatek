import { prisma } from "../../config/db";

// اتجاه المبيعات الفعلي لآخر N يوم - مجموع حقيقي لكل يوم من جدول Sale،
// مش تنبؤ أو تخمين. ده بديل صادق لأي "توقع AI" مالوش أساس حقيقي.
export async function getRevenueTrend(tenantId: string, days = 30) {
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const sales = await prisma.sale.findMany({
    where: { tenantId, createdAt: { gte: start } },
    select: { totalAmount: true, createdAt: true },
  });

  const byDay = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const s of sales) {
    const key = new Date(s.createdAt).toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(s.totalAmount));
  }

  return Array.from(byDay.entries()).map(([date, revenue]) => ({ date, revenue }));
}

// مقارنة أداء حقيقية بين كل الفروع - إيرادات وعدد طلبات ومخزون منخفض
// لكل فرع، محسوبين من بيانات فعلية، مش أرقام موزّعة عشوائيًا
export async function getBranchPerformance(tenantId: string) {
  const branches = await prisma.branch.findMany({ where: { tenantId } });

  const results = await Promise.all(
    branches.map(async (branch: { id: string; name: string }) => {
      const [sales, items] = await Promise.all([
        prisma.sale.findMany({ where: { tenantId, branchId: branch.id } }),
        prisma.inventoryItem.findMany({ where: { tenantId, branchId: branch.id } }),
      ]);

      const revenue = sales.reduce((sum: number, s: { totalAmount: unknown }) => sum + Number(s.totalAmount), 0);
      const lowStockCount = items.filter((i: { quantity: number; reorderAt: number }) => i.quantity <= i.reorderAt).length;

      return {
        branchId: branch.id,
        branchName: branch.name,
        revenue,
        orderCount: sales.length,
        inventoryCount: items.length,
        lowStockCount,
      };
    })
  );

  return results;
}
