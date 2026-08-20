import { prisma } from "../../config/db";

export async function getOrCreateWhatsappSettings(tenantId: string) {
  const existing = await prisma.whatsappSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.whatsappSettings.create({ data: { tenantId } });
}

interface UnifiedContact {
  name: string;
  phone: string;
  sources: string[];
  lastActivity: Date;
}

// جهات اتصال حقيقية 100% - مجمّعة من العملاء الفعليين في بطاقة الولاء،
// الحجوزات، وطلبات الكتالوج. مفيش رقم واحد وهمي هنا، كله مبني على
// بيانات حقيقية موجودة بالفعل في النظام.
export async function getUnifiedContacts(tenantId: string): Promise<UnifiedContact[]> {
  const [walletCustomers, bookings, orders] = await Promise.all([
    prisma.walletCustomer.findMany({ where: { tenantId } }),
    prisma.booking.findMany({ where: { tenantId } }),
    prisma.catalogOrder.findMany({ where: { tenantId } }),
  ]);

  const byPhone = new Map<string, UnifiedContact>();

  function upsert(name: string, phone: string, source: string, activityDate: Date) {
    if (!phone) return;
    const existing = byPhone.get(phone);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (activityDate > existing.lastActivity) existing.lastActivity = activityDate;
    } else {
      byPhone.set(phone, { name, phone, sources: [source], lastActivity: activityDate });
    }
  }

  for (const c of walletCustomers) {
    upsert(c.name, c.phone, "Wallet Member", c.lastVisitAt ?? c.createdAt);
  }
  for (const b of bookings) {
    upsert(b.customerName, b.customerPhone, "Booking Customer", b.createdAt);
  }
  for (const o of orders) {
    upsert(o.customerName, o.customerPhone, "Catalog Customer", o.createdAt);
  }

  return Array.from(byPhone.values()).sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}
