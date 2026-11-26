import { Prisma, type PrismaClient } from "@prisma/client";

// كل كلام Prisma بتاع الشحن هنا بس - وكل استعلام متفلتر بالـ tenantId
export class ShippingRepository {
  constructor(private readonly db: PrismaClient) {}

  productWeights(tenantId: string, ids: string[]) {
    return this.db.storeProduct.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, weightKg: true } });
  }

  // ---------- إعدادات المتجر (طرق الشحن / العنوان / الكرتونة) ----------
  async settings(tenantId: string) {
    const found = await this.db.storeSettings.findUnique({ where: { tenantId } });
    if (found) return found;
    try {
      return await this.db.storeSettings.create({ data: { tenantId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return this.db.storeSettings.findUniqueOrThrow({ where: { tenantId } });
      throw e;
    }
  }
  async saveSettings(tenantId: string, data: Prisma.StoreSettingsUpdateInput) {
    await this.settings(tenantId);
    return this.db.storeSettings.update({ where: { tenantId }, data });
  }

  // ---------- حسابات شركات الشحن ----------
  accounts(tenantId: string) {
    return this.db.storeCarrierAccount.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  }
  account(tenantId: string, carrier: string) {
    return this.db.storeCarrierAccount.findUnique({ where: { tenantId_carrier: { tenantId, carrier } } });
  }
  upsertAccount(tenantId: string, carrier: string, data: { mode: string; credentials: string; accountHint: string; lastCheckedAt: Date; lastError: string | null }) {
    return this.db.storeCarrierAccount.upsert({
      where: { tenantId_carrier: { tenantId, carrier } },
      create: { tenantId, carrier, enabled: true, ...data },
      update: { enabled: true, ...data },
    });
  }
  markAccountChecked(tenantId: string, carrier: string, lastError: string | null) {
    return this.db.storeCarrierAccount.updateMany({ where: { tenantId, carrier }, data: { lastCheckedAt: new Date(), lastError } });
  }
  setAccountEnabled(tenantId: string, carrier: string, enabled: boolean) {
    return this.db.storeCarrierAccount.updateMany({ where: { tenantId, carrier }, data: { enabled } });
  }
  deleteAccount(tenantId: string, carrier: string) {
    return this.db.storeCarrierAccount.deleteMany({ where: { tenantId, carrier } });
  }

  // ---------- الطلبات ----------
  order(tenantId: string, id: string) {
    return this.db.storeOrder.findFirst({ where: { id, tenantId } });
  }
  // الطلب اتشحن: NEW/CONFIRMED → SHIPPED (+ رابط التتبع لو مفيش)
  async markOrderShipped(tenantId: string, id: string, trackingUrl: string | null) {
    await this.db.storeOrder.updateMany({ where: { id, tenantId, status: { in: ["NEW", "CONFIRMED"] } }, data: { status: "SHIPPED" } });
    if (trackingUrl) await this.db.storeOrder.updateMany({ where: { id, tenantId, trackingUrl: null }, data: { trackingUrl } });
  }
  markOrderDelivered(tenantId: string, id: string) {
    return this.db.storeOrder.updateMany({ where: { id, tenantId, status: { in: ["NEW", "CONFIRMED", "SHIPPED"] } }, data: { status: "DELIVERED" } });
  }

  // ---------- الشحنات ----------
  shipment(tenantId: string, orderId: string) {
    return this.db.storeShipment.findFirst({ where: { tenantId, orderId } });
  }
  shipmentMeta(tenantId: string, orderIds: string[]) {
    return this.db.storeShipment.findMany({
      where: { tenantId, orderId: { in: orderIds } },
      select: { orderId: true, carrier: true, service: true, status: true, trackingNumber: true, trackingStatus: true, trackingEvents: true, lastTrackedAt: true, deliveredAt: true, error: true, labelUrl: true, mode: true, createdAt: true },
    });
  }
  // حجز إنشاء الشحنة (claim): أول ضغطة بس اللي بتكمل. فشل قبل كده أو "بيتعمل" من أكتر من 5 دقايق = ينفع تاني
  async claimShipment(tenantId: string, orderId: string, carrier: string, service: string | null, mode: string): Promise<boolean> {
    try {
      await this.db.storeShipment.create({ data: { tenantId, orderId, carrier, service, mode, status: "CREATING" } });
      return true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
    const stale = new Date(Date.now() - 5 * 60_000);
    const r = await this.db.storeShipment.updateMany({
      where: { tenantId, orderId, OR: [{ status: "FAILED" }, { status: "CREATING", updatedAt: { lt: stale } }] },
      data: { status: "CREATING", carrier, service, mode, error: null },
    });
    return r.count === 1;
  }
  shipmentFailed(tenantId: string, orderId: string, error: string) {
    return this.db.storeShipment.updateMany({ where: { tenantId, orderId, status: "CREATING" }, data: { status: "FAILED", error: error.slice(0, 500) } });
  }
  shipmentCreated(tenantId: string, orderId: string, data: { trackingNumber: string; service: string; labelPdf: Buffer | null; labelUrl: string | null }) {
    return this.db.storeShipment.updateMany({
      where: { tenantId, orderId, status: "CREATING" },
      data: { status: "CREATED", trackingNumber: data.trackingNumber, service: data.service, labelPdf: data.labelPdf ?? null, labelUrl: data.labelUrl, trackingStatus: "PENDING", trackingEvents: [], error: null },
    });
  }
  saveTracking(tenantId: string, orderId: string, data: { trackingStatus: string; trackingEvents: Prisma.InputJsonValue; deliveredAt?: Date | null }) {
    return this.db.storeShipment.updateMany({ where: { tenantId, orderId, status: "CREATED" }, data: { ...data, lastTrackedAt: new Date() } });
  }
  trackingFailed(tenantId: string, orderId: string, error: string) {
    return this.db.storeShipment.updateMany({ where: { tenantId, orderId }, data: { lastTrackedAt: new Date(), error: error.slice(0, 500) } });
  }
  label(tenantId: string, orderId: string) {
    return this.db.storeShipment.findFirst({ where: { tenantId, orderId, status: "CREATED" }, select: { labelPdf: true, labelUrl: true, trackingNumber: true, carrier: true } });
  }
  // للشغلانة اللي بتتابع التتبع: شحنات لسه ماوصلتش، آخر 60 يوم، ماتحدّثتش من شوية
  dueForTracking(olderThan: Date, take: number) {
    return this.db.storeShipment.findMany({
      where: {
        status: "CREATED",
        trackingNumber: { not: null },
        OR: [{ trackingStatus: null }, { trackingStatus: { not: "DELIVERED" } }],
        createdAt: { gte: new Date(Date.now() - 60 * 86400_000) },
        AND: [{ OR: [{ lastTrackedAt: null }, { lastTrackedAt: { lt: olderThan } }] }],
      },
      select: { tenantId: true, orderId: true },
      orderBy: { lastTrackedAt: { sort: "asc", nulls: "first" } },
      take,
    });
  }
}
