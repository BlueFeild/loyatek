import { prisma } from "../../config/db";

type NotificationType = "BOOKING_CONFIRMED" | "CATALOG_ORDER";

interface CreateNotificationInput {
  tenantId: string;
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
}

// إنشاء إشعار حقيقي - بيتنادى من جوه أي flow مهم (حجز اتأكد، أوردر
// جديد...). فشل الإشعار (لو حصل) مبيوقفش العملية الأساسية اللي بتنادي
// عليه - الإشعار ثانوي، مش أساسي للعملية
export async function createNotification(input: CreateNotificationInput) {
  try {
    return await prisma.notification.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        title: input.title,
        body: input.body,
        link: input.link,
      },
    });
  } catch {
    return null;
  }
}

export async function listNotifications(tenantId: string, limit = 30) {
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { tenantId, read: false } }),
  ]);
  return { items, unreadCount };
}

export async function markNotificationRead(tenantId: string, id: string) {
  const notification = await prisma.notification.findFirst({ where: { id, tenantId } });
  if (!notification) throw new Error("Notification not found");
  return prisma.notification.update({ where: { id }, data: { read: true } });
}

export async function markAllNotificationsRead(tenantId: string) {
  await prisma.notification.updateMany({ where: { tenantId, read: false }, data: { read: true } });
  return { ok: true };
}
