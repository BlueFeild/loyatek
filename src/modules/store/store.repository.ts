import { Prisma, type PrismaClient } from "@prisma/client";

// كل كلام Prisma بتاع المتجر هنا بس - وكل استعلام متفلتر بالـ tenantId
export type Tx = Prisma.TransactionClient;

const PHOTO_META = { id: true, sortOrder: true, createdAt: true } as const;
const WITH_ALL = {
  photos: { select: PHOTO_META, orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  variations: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
};

export class StoreRepository {
  constructor(private readonly db: PrismaClient) {}

  // ---------- الإعدادات ----------
  async settings(tenantId: string) {
    const found = await this.db.storeSettings.findUnique({ where: { tenantId } });
    if (found) return found;
    try {
      return await this.db.storeSettings.create({ data: { tenantId } });
    } catch (e) {
      // طلبين في نفس اللحظة: التاني يقرا اللي اتعمل
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return this.db.storeSettings.findUniqueOrThrow({ where: { tenantId } });
      throw e;
    }
  }

  async saveSettings(tenantId: string, data: Prisma.StoreSettingsUpdateInput) {
    await this.settings(tenantId);
    return this.db.storeSettings.update({ where: { tenantId }, data });
  }

  tenantBySlug(slug: string) {
    return this.db.tenant.findUnique({ where: { slug } });
  }

  tenant(id: string) {
    return this.db.tenant.findUnique({ where: { id }, select: { id: true, slug: true, name: true, displayCurrency: true } });
  }

  async timezone(tenantId: string): Promise<string> {
    const b = await this.db.bookingSettings.findUnique({ where: { tenantId }, select: { timezone: true } }).catch(() => null);
    return b?.timezone || "Asia/Qatar";
  }

  // ---------- المنتجات ----------
  // status: PUBLISHED = في القوايم، HIDDEN = بالرابط بس، DRAFT = مقفول
  products(tenantId: string, statuses?: string[]) {
    return this.db.storeProduct.findMany({
      where: { tenantId, ...(statuses ? { status: { in: statuses } } : {}) },
      include: WITH_ALL,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });
  }
  product(tenantId: string, id: string) {
    return this.db.storeProduct.findFirst({ where: { id, tenantId }, include: WITH_ALL });
  }
  productBySlug(tenantId: string, slug: string) {
    return this.db.storeProduct.findFirst({ where: { slug, tenantId }, include: WITH_ALL });
  }
  productsByIds(tenantId: string, ids: string[]) {
    return this.db.storeProduct.findMany({ where: { tenantId, id: { in: ids } }, include: WITH_ALL });
  }
  productRefs(tenantId: string, ids: string[]) {
    return this.db.storeProduct.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
  }
  productSlugs(tenantId: string) {
    return this.db.storeProduct.findMany({ where: { tenantId, slug: { not: null } }, select: { id: true, slug: true } });
  }
  productsBySku(tenantId: string, skus: string[]) {
    return this.db.storeProduct.findMany({ where: { tenantId, sku: { in: skus } }, select: { id: true, sku: true } });
  }
  countProducts(tenantId: string) {
    return this.db.storeProduct.count({ where: { tenantId } });
  }
  async createProduct(tenantId: string, data: Omit<Prisma.StoreProductUncheckedCreateInput, "tenantId">, tx?: Tx) {
    const db = tx ?? this.db;
    const first = await db.storeProduct.aggregate({ where: { tenantId }, _min: { sortOrder: true } });
    return db.storeProduct.create({ data: { ...data, tenantId, sortOrder: (first._min.sortOrder ?? 1) - 1 } });
  }
  updateProduct(tenantId: string, id: string, data: Prisma.StoreProductUncheckedUpdateManyInput, tx?: Tx) {
    return (tx ?? this.db).storeProduct.updateMany({ where: { id, tenantId }, data });
  }
  deleteProduct(tenantId: string, id: string) {
    return this.db.storeProduct.deleteMany({ where: { id, tenantId } });
  }
  orderProducts(tenantId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeProduct.updateMany({ where: { id, tenantId }, data: { sortOrder: i } })));
  }

  // ---------- الصور ----------
  photosMeta(tenantId: string, productId: string) {
    return this.db.storeProductPhoto.findMany({ where: { tenantId, productId }, select: { id: true } });
  }
  photoCount(tenantId: string, productId: string) {
    return this.db.storeProductPhoto.count({ where: { tenantId, productId } });
  }
  async addPhoto(tenantId: string, productId: string, dataUrl: string) {
    const last = await this.db.storeProductPhoto.aggregate({ where: { tenantId, productId }, _max: { sortOrder: true } });
    return this.db.storeProductPhoto.create({ data: { tenantId, productId, dataUrl, sortOrder: (last._max.sortOrder ?? -1) + 1 }, select: PHOTO_META });
  }
  deletePhoto(tenantId: string, productId: string, photoId: string) {
    return this.db.storeProductPhoto.deleteMany({ where: { id: photoId, tenantId, productId } });
  }
  orderPhotos(tenantId: string, productId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeProductPhoto.updateMany({ where: { id, tenantId, productId }, data: { sortOrder: i } })));
  }
  photosWithData(tenantId: string, productId: string) {
    return this.db.storeProductPhoto.findMany({ where: { tenantId, productId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  }
  copyPhotos(tenantId: string, productId: string, photos: { dataUrl: string; sortOrder: number }[]) {
    return this.db.storeProductPhoto.createMany({ data: photos.map((p) => ({ tenantId, productId, dataUrl: p.dataUrl, sortOrder: p.sortOrder })) });
  }
  photoBytes(tenantId: string, photoId: string) {
    return this.db.storeProductPhoto.findFirst({ where: { id: photoId, tenantId }, select: { id: true, dataUrl: true, createdAt: true } });
  }

  // ---------- الطلبات ----------
  orders(tenantId: string, status?: string) {
    return this.db.storeOrder.findMany({ where: { tenantId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
  }
  order(tenantId: string, id: string) {
    return this.db.storeOrder.findFirst({ where: { id, tenantId } });
  }
  async orderStats(tenantId: string, todayStart: Date, weekStart: Date) {
    const notCancelled = { tenantId, status: { not: "CANCELLED" } };
    const [today, week, newCount, weekSum] = await Promise.all([
      this.db.storeOrder.count({ where: { ...notCancelled, createdAt: { gte: todayStart } } }),
      this.db.storeOrder.count({ where: { ...notCancelled, createdAt: { gte: weekStart } } }),
      this.db.storeOrder.count({ where: { tenantId, status: "NEW" } }),
      this.db.storeOrder.aggregate({ where: { ...notCancelled, createdAt: { gte: weekStart } }, _sum: { total: true } }),
    ]);
    return { today, week, newCount, weekRevenue: Number(weekSum._sum.total ?? 0) };
  }
  updateOrder(tenantId: string, id: string, data: Prisma.StoreOrderUpdateManyMutationInput) {
    return this.db.storeOrder.updateMany({ where: { id, tenantId }, data });
  }
  // الدفع اتأكد من البوابة: UNPAID -> PAID مرة واحدة بس (رجوع العميل + webhook في نفس اللحظة)
  markPaidIfUnpaid(tenantId: string, id: string) {
    return this.db.storeOrder.updateMany({ where: { id, tenantId, paymentStatus: "UNPAID" }, data: { paymentStatus: "PAID" } });
  }
  // تحويل الحالة بشرط (claim) - بيرجع 1 لو اتغيرت فعلًا
  claimOrder(tx: Tx, tenantId: string, id: string, where: Prisma.StoreOrderWhereInput, data: Prisma.StoreOrderUpdateManyMutationInput) {
    return tx.storeOrder.updateMany({ where: { ...where, id, tenantId }, data });
  }

  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(fn);
  }

  // بينقص المخزون بشرط إنه يكفي (null = مفتوح، والطرح من null بيفضل null). backorders = يقبل حتى لو مفيش
  takeStock(tx: Tx, tenantId: string, productId: string, qty: number) {
    return tx.storeProduct.updateMany({
      where: { id: productId, tenantId, active: true, OR: [{ stock: null }, { stock: { gte: qty } }, { backorders: true }] },
      data: { stock: { decrement: qty } },
    });
  }
  takeVariationStock(tx: Tx, tenantId: string, productId: string, variationId: string, qty: number, backorders: boolean) {
    return tx.storeProductVariation.updateMany({
      where: { id: variationId, productId, tenantId, enabled: true, ...(backorders ? {} : { OR: [{ stock: null }, { stock: { gte: qty } }] }) },
      data: { stock: { decrement: qty } },
    });
  }
  returnStock(tx: Tx, tenantId: string, productId: string, qty: number) {
    return tx.storeProduct.updateMany({ where: { id: productId, tenantId, stock: { not: null } }, data: { stock: { increment: qty } } });
  }
  returnVariationStock(tx: Tx, tenantId: string, variationId: string, qty: number) {
    return tx.storeProductVariation.updateMany({ where: { id: variationId, tenantId, stock: { not: null } }, data: { stock: { increment: qty } } });
  }
  stockOf(tx: Tx, tenantId: string, productId: string) {
    return tx.storeProduct.findFirst({ where: { id: productId, tenantId }, select: { stock: true, name: true, lowStockAt: true } });
  }
  variationStockOf(tx: Tx, tenantId: string, variationId: string) {
    return tx.storeProductVariation.findFirst({ where: { id: variationId, tenantId }, select: { stock: true } });
  }
  addSold(tx: Tx, tenantId: string, productId: string, qty: number) {
    return tx.storeProduct.updateMany({ where: { id: productId, tenantId }, data: { soldCount: { increment: qty } } });
  }
  async nextOrderNumber(tx: Tx, tenantId: string) {
    const max = await tx.storeOrder.aggregate({ where: { tenantId }, _max: { number: true } });
    return (max._max.number ?? 0) + 1;
  }
  createOrder(tx: Tx, data: Prisma.StoreOrderUncheckedCreateInput) {
    return tx.storeOrder.create({ data });
  }
}
