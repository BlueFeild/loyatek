import { Prisma, type PrismaClient } from "@prisma/client";

// كل كلام Prisma بتاع المتجر هنا بس - وكل استعلام متفلتر بالـ tenantId
export type Tx = Prisma.TransactionClient;

const PHOTO_META = { id: true, sortOrder: true, createdAt: true } as const;

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

  // ---------- الأقسام ----------
  categories(tenantId: string) {
    return this.db.storeCategory.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  }
  category(tenantId: string, id: string) {
    return this.db.storeCategory.findFirst({ where: { id, tenantId } });
  }
  async createCategory(tenantId: string, name: string) {
    const last = await this.db.storeCategory.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
    return this.db.storeCategory.create({ data: { tenantId, name, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }
  renameCategory(tenantId: string, id: string, name: string) {
    return this.db.storeCategory.updateMany({ where: { id, tenantId }, data: { name } });
  }
  async deleteCategory(tenantId: string, id: string) {
    return this.db.$transaction([
      this.db.storeProduct.updateMany({ where: { tenantId, categoryId: id }, data: { categoryId: null } }),
      this.db.storeCategory.deleteMany({ where: { id, tenantId } }),
    ]);
  }
  orderCategories(tenantId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeCategory.updateMany({ where: { id, tenantId }, data: { sortOrder: i } })));
  }

  // ---------- المنتجات ----------
  products(tenantId: string, onlyActive = false) {
    return this.db.storeProduct.findMany({
      where: { tenantId, ...(onlyActive ? { active: true } : {}) },
      include: { photos: { select: PHOTO_META, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });
  }
  product(tenantId: string, id: string) {
    return this.db.storeProduct.findFirst({
      where: { id, tenantId },
      include: { photos: { select: PHOTO_META, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
  }
  productsByIds(tenantId: string, ids: string[]) {
    return this.db.storeProduct.findMany({
      where: { tenantId, id: { in: ids } },
      include: { photos: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 1 } },
    });
  }
  countProducts(tenantId: string) {
    return this.db.storeProduct.count({ where: { tenantId } });
  }
  async createProduct(tenantId: string, data: Omit<Prisma.StoreProductUncheckedCreateInput, "tenantId">) {
    const first = await this.db.storeProduct.aggregate({ where: { tenantId }, _min: { sortOrder: true } });
    return this.db.storeProduct.create({ data: { ...data, tenantId, sortOrder: (first._min.sortOrder ?? 1) - 1 } });
  }
  updateProduct(tenantId: string, id: string, data: Prisma.StoreProductUncheckedUpdateManyInput) {
    return this.db.storeProduct.updateMany({ where: { id, tenantId }, data });
  }
  deleteProduct(tenantId: string, id: string) {
    return this.db.storeProduct.deleteMany({ where: { id, tenantId } });
  }
  orderProducts(tenantId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeProduct.updateMany({ where: { id, tenantId }, data: { sortOrder: i } })));
  }

  // ---------- الصور ----------
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

  // بينقص المخزون بشرط إنه يكفي (null = مفتوح، والطرح من null بيفضل null)
  takeStock(tx: Tx, tenantId: string, productId: string, qty: number) {
    return tx.storeProduct.updateMany({
      where: { id: productId, tenantId, active: true, OR: [{ stock: null }, { stock: { gte: qty } }] },
      data: { stock: { decrement: qty } },
    });
  }
  returnStock(tx: Tx, tenantId: string, productId: string, qty: number) {
    return tx.storeProduct.updateMany({ where: { id: productId, tenantId, stock: { not: null } }, data: { stock: { increment: qty } } });
  }
  stockOf(tx: Tx, tenantId: string, productId: string) {
    return tx.storeProduct.findFirst({ where: { id: productId, tenantId }, select: { stock: true, name: true } });
  }
  async nextOrderNumber(tx: Tx, tenantId: string) {
    const max = await tx.storeOrder.aggregate({ where: { tenantId }, _max: { number: true } });
    return (max._max.number ?? 0) + 1;
  }
  createOrder(tx: Tx, data: Prisma.StoreOrderUncheckedCreateInput) {
    return tx.storeOrder.create({ data });
  }
}
