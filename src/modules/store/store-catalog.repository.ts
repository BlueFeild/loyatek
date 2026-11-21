import { Prisma, type PrismaClient } from "@prisma/client";

// Prisma بتاع الكتالوج (أقسام، خصائص + قيمها، تاجز، اختيارات، كوبونات، سلايدر) - كل استعلام متفلتر بالـ tenantId
export type Tx = Prisma.TransactionClient;
const TERM_META = { id: true, attributeId: true, name: true, slug: true, color: true, sortOrder: true } as const;

export class StoreCatalogRepository {
  constructor(private readonly db: PrismaClient) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(fn);
  }

  // ---------- الأقسام ----------
  categories(tenantId: string) {
    return this.db.storeCategory.findMany({
      where: { tenantId },
      select: { id: true, parentId: true, name: true, slug: true, description: true, sortOrder: true, createdAt: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }
  category(tenantId: string, id: string) {
    return this.db.storeCategory.findFirst({ where: { id, tenantId }, select: { id: true, parentId: true, name: true, slug: true, description: true, sortOrder: true, createdAt: true } });
  }
  // الصور تقيلة: بنجيب بس مين عنده صورة (+ بصمة صغيرة للكاش)
  async categoryImageTags(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db.$queryRaw<{ id: string; h: string }[]>`SELECT id, left(md5("imageDataUrl"), 12) AS h FROM "store_categories" WHERE "tenantId" = ${tenantId} AND "imageDataUrl" IS NOT NULL`;
    return new Map(rows.map((r) => [r.id, r.h]));
  }
  async termImageTags(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db.$queryRaw<{ id: string; h: string }[]>`SELECT id, left(md5("imageDataUrl"), 12) AS h FROM "store_attribute_terms" WHERE "tenantId" = ${tenantId} AND "imageDataUrl" IS NOT NULL`;
    return new Map(rows.map((r) => [r.id, r.h]));
  }
  categoryImage(tenantId: string, id: string) {
    return this.db.storeCategory.findFirst({ where: { id, tenantId }, select: { imageDataUrl: true } });
  }
  async createCategory(tenantId: string, data: Omit<Prisma.StoreCategoryUncheckedCreateInput, "tenantId" | "sortOrder">) {
    const last = await this.db.storeCategory.aggregate({ where: { tenantId, parentId: data.parentId ?? null }, _max: { sortOrder: true } });
    return this.db.storeCategory.create({ data: { ...data, tenantId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }
  updateCategory(tenantId: string, id: string, data: Prisma.StoreCategoryUncheckedUpdateManyInput) {
    return this.db.storeCategory.updateMany({ where: { id, tenantId }, data });
  }
  // المسح: ولاده بيطلعوا مكانه، والمنتجات بتتشال منه
  async deleteCategory(tenantId: string, id: string, parentId: string | null) {
    await this.db.$transaction(async (tx) => {
      await tx.storeCategory.updateMany({ where: { tenantId, parentId: id }, data: { parentId } });
      await tx.$executeRaw`UPDATE "store_products" SET "categoryIds" = array_remove("categoryIds", ${id}), "categoryId" = CASE WHEN "categoryId" = ${id} THEN (array_remove("categoryIds", ${id}))[1] ELSE "categoryId" END WHERE "tenantId" = ${tenantId} AND ${id} = ANY("categoryIds")`;
      await tx.storeCategory.deleteMany({ where: { id, tenantId } });
    });
  }
  orderCategories(tenantId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeCategory.updateMany({ where: { id, tenantId }, data: { sortOrder: i } })));
  }
  // عدد المنتجات في كل قسم (مباشرة)
  async categoryCounts(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.db.$queryRaw<{ id: string; n: bigint }[]>`SELECT c AS id, count(*) AS n FROM "store_products", unnest("categoryIds") AS c WHERE "tenantId" = ${tenantId} GROUP BY c`;
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  // ---------- الخصائص ----------
  attributes(tenantId: string) {
    return this.db.storeAttribute.findMany({
      where: { tenantId },
      include: { terms: { select: TERM_META, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }
  attribute(tenantId: string, id: string) {
    return this.db.storeAttribute.findFirst({ where: { id, tenantId }, include: { terms: { select: TERM_META, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } });
  }
  async createAttribute(tenantId: string, data: { name: string; slug: string; display: string }) {
    const last = await this.db.storeAttribute.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
    return this.db.storeAttribute.create({ data: { ...data, tenantId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }
  updateAttribute(tenantId: string, id: string, data: Prisma.StoreAttributeUpdateManyMutationInput) {
    return this.db.storeAttribute.updateMany({ where: { id, tenantId }, data });
  }
  deleteAttribute(tenantId: string, id: string) {
    return this.db.storeAttribute.deleteMany({ where: { id, tenantId } });
  }
  countAttributes(tenantId: string) {
    return this.db.storeAttribute.count({ where: { tenantId } });
  }
  term(tenantId: string, id: string) {
    return this.db.storeAttributeTerm.findFirst({ where: { id, tenantId }, select: TERM_META });
  }
  async createTerm(tenantId: string, attributeId: string, data: { name: string; slug: string; color?: string | null; imageDataUrl?: string | null }) {
    const last = await this.db.storeAttributeTerm.aggregate({ where: { tenantId, attributeId }, _max: { sortOrder: true } });
    return this.db.storeAttributeTerm.create({ data: { ...data, tenantId, attributeId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }
  updateTerm(tenantId: string, id: string, data: Prisma.StoreAttributeTermUpdateManyMutationInput) {
    return this.db.storeAttributeTerm.updateMany({ where: { id, tenantId }, data });
  }
  deleteTerm(tenantId: string, id: string) {
    return this.db.storeAttributeTerm.deleteMany({ where: { id, tenantId } });
  }
  orderTerms(tenantId: string, attributeId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeAttributeTerm.updateMany({ where: { id, tenantId, attributeId }, data: { sortOrder: i } })));
  }
  termImage(tenantId: string, id: string) {
    return this.db.storeAttributeTerm.findFirst({ where: { id, tenantId }, select: { imageDataUrl: true } });
  }
  termsByIds(tenantId: string, ids: string[]) {
    return this.db.storeAttributeTerm.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, attributeId: true } });
  }
  // منتجات بتستخدم خاصية (عشان نمنع المسح ونقول للتاجر)
  async productsUsingAttribute(tenantId: string, attributeId: string) {
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "store_products" WHERE "tenantId" = ${tenantId} AND "attributes" @> ${JSON.stringify([{ attributeId }])}::jsonb`;
    return Number(rows[0]?.n ?? 0);
  }
  async variationsUsingTerm(tenantId: string, termId: string) {
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "store_product_variations" v, jsonb_each_text(v."attrs") e WHERE v."tenantId" = ${tenantId} AND e.value = ${termId}`;
    return Number(rows[0]?.n ?? 0);
  }

  // ---------- التاجز ----------
  tags(tenantId: string) {
    return this.db.storeTag.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  }
  tagsByIds(tenantId: string, ids: string[]) {
    return this.db.storeTag.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
  }
  createTag(tenantId: string, name: string, slug: string) {
    return this.db.storeTag.create({ data: { tenantId, name, slug } });
  }
  updateTag(tenantId: string, id: string, name: string, slug: string) {
    return this.db.storeTag.updateMany({ where: { id, tenantId }, data: { name, slug } });
  }
  async deleteTag(tenantId: string, id: string) {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "store_products" SET "tagIds" = array_remove("tagIds", ${id}) WHERE "tenantId" = ${tenantId} AND ${id} = ANY("tagIds")`;
      await tx.storeTag.deleteMany({ where: { id, tenantId } });
    });
  }
  async tagCounts(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.db.$queryRaw<{ id: string; n: bigint }[]>`SELECT t AS id, count(*) AS n FROM "store_products", unnest("tagIds") AS t WHERE "tenantId" = ${tenantId} GROUP BY t`;
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  // ---------- الاختيارات ----------
  variations(tenantId: string, productId: string) {
    return this.db.storeProductVariation.findMany({ where: { tenantId, productId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  }
  variation(tenantId: string, productId: string, id: string) {
    return this.db.storeProductVariation.findFirst({ where: { id, tenantId, productId } });
  }
  async createVariations(tenantId: string, productId: string, rows: { attrs: Record<string, string>; signature: string; price?: number | null; stock?: number | null; sku?: string | null }[]) {
    const last = await this.db.storeProductVariation.aggregate({ where: { tenantId, productId }, _max: { sortOrder: true } });
    let order = (last._max.sortOrder ?? -1) + 1;
    return this.db.storeProductVariation.createMany({
      data: rows.map((r) => ({ tenantId, productId, attrs: r.attrs, signature: r.signature, price: r.price ?? null, stock: r.stock ?? null, sku: r.sku ?? null, sortOrder: order++ })),
      skipDuplicates: true,
    });
  }
  updateVariation(tenantId: string, productId: string, id: string, data: Prisma.StoreProductVariationUpdateManyMutationInput) {
    return this.db.storeProductVariation.updateMany({ where: { id, tenantId, productId }, data });
  }
  updateVariations(tenantId: string, productId: string, ids: string[], data: Prisma.StoreProductVariationUpdateManyMutationInput) {
    return this.db.storeProductVariation.updateMany({ where: { id: { in: ids }, tenantId, productId }, data });
  }
  deleteVariation(tenantId: string, productId: string, id: string) {
    return this.db.storeProductVariation.deleteMany({ where: { id, tenantId, productId } });
  }
  deleteVariationsNotIn(tenantId: string, productId: string, keepIds: string[]) {
    return this.db.storeProductVariation.deleteMany({ where: { tenantId, productId, id: { notIn: keepIds } } });
  }
  countVariations(tenantId: string, productId: string) {
    return this.db.storeProductVariation.count({ where: { tenantId, productId } });
  }
  clearVariationPhoto(tenantId: string, productId: string, photoId: string) {
    return this.db.storeProductVariation.updateMany({ where: { tenantId, productId, photoId }, data: { photoId: null } });
  }

  // ---------- الكوبونات ----------
  coupons(tenantId: string) {
    return this.db.storeCoupon.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } });
  }
  coupon(tenantId: string, id: string) {
    return this.db.storeCoupon.findFirst({ where: { id, tenantId } });
  }
  couponByCode(tenantId: string, code: string) {
    return this.db.storeCoupon.findFirst({ where: { tenantId, code } });
  }
  countCoupons(tenantId: string) {
    return this.db.storeCoupon.count({ where: { tenantId } });
  }
  createCoupon(tenantId: string, data: Omit<Prisma.StoreCouponUncheckedCreateInput, "tenantId">) {
    return this.db.storeCoupon.create({ data: { ...data, tenantId } });
  }
  updateCoupon(tenantId: string, id: string, data: Prisma.StoreCouponUpdateManyMutationInput) {
    return this.db.storeCoupon.updateMany({ where: { id, tenantId }, data });
  }
  deleteCoupon(tenantId: string, id: string) {
    return this.db.storeCoupon.deleteMany({ where: { id, tenantId } });
  }
  customerUses(tenantId: string, couponId: string, phoneKey: string, tx?: Tx) {
    return (tx ?? this.db).storeCouponUse.count({ where: { tenantId, couponId, phoneKey } });
  }
  // استخدام الكوبون (بشرط إنه لسه ليه استخدامات) - بيقفل صف الكوبون لحد آخر الـ transaction
  claimCoupon(tx: Tx, tenantId: string, couponId: string) {
    return tx.$executeRaw`UPDATE "store_coupons" SET "usedCount" = "usedCount" + 1, "updatedAt" = now() WHERE "id" = ${couponId} AND "tenantId" = ${tenantId} AND "active" = true AND ("maxUses" IS NULL OR "usedCount" < "maxUses") AND ("expiresAt" IS NULL OR "expiresAt" > now())`;
  }
  recordCouponUse(tx: Tx, data: { tenantId: string; couponId: string; orderId: string; phoneKey: string }) {
    return tx.storeCouponUse.create({ data });
  }
  async releaseCoupon(tx: Tx, tenantId: string, couponId: string, orderId: string) {
    const r = await tx.storeCouponUse.deleteMany({ where: { tenantId, couponId, orderId } });
    if (r.count) await tx.$executeRaw`UPDATE "store_coupons" SET "usedCount" = GREATEST("usedCount" - 1, 0) WHERE "id" = ${couponId} AND "tenantId" = ${tenantId}`;
  }

  // ---------- السلايدر ----------
  banners(tenantId: string) {
    return this.db.storeBanner.findMany({
      where: { tenantId },
      select: { id: true, title: true, subtitle: true, buttonText: true, link: true, sortOrder: true, createdAt: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
  }
  banner(tenantId: string, id: string) {
    return this.db.storeBanner.findFirst({ where: { id, tenantId } });
  }
  countBanners(tenantId: string) {
    return this.db.storeBanner.count({ where: { tenantId } });
  }
  async createBanner(tenantId: string, data: { dataUrl: string; title?: string | null; subtitle?: string | null; buttonText?: string | null; link?: string | null }) {
    const last = await this.db.storeBanner.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
    return this.db.storeBanner.create({ data: { ...data, tenantId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }
  updateBanner(tenantId: string, id: string, data: Prisma.StoreBannerUpdateManyMutationInput) {
    return this.db.storeBanner.updateMany({ where: { id, tenantId }, data });
  }
  deleteBanner(tenantId: string, id: string) {
    return this.db.storeBanner.deleteMany({ where: { id, tenantId } });
  }
  orderBanners(tenantId: string, ids: string[]) {
    return this.db.$transaction(ids.map((id, i) => this.db.storeBanner.updateMany({ where: { id, tenantId }, data: { sortOrder: i } })));
  }
}
