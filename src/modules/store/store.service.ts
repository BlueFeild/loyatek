import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError, NotFoundError } from "../../core/errors";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { formatUsdAs, getRates, getTenantMoney, isCurrencyCode, payableAmount, rateFor } from "../../utils/money";
import { isModuleLive } from "../../utils/platform-config";
import { todayKeyInTimezone } from "../../utils/calendarDate";
import { zonedDateHourToUtc } from "../../utils/timezone";
import { checkTenantMyFatoorahPaymentStatus, getTenantPaymentMethods, paymentInvoiceMatch, startTenantPayment, verifyTenantGatewayPayment } from "../checkout/myfatoorah";
import { confirmsOnOrder, isAutoGateway, pickPaymentMethod, publicPaymentMethods, shortReference, type PaymentMethod } from "../payment-settings/payment-methods";
import { MAX_PHOTOS, MAX_PRODUCTS, canChangeStatus, decodeDataUrl, readAreas, type CheckoutInput, type OrderStatus, type QuoteInput } from "./store.logic";
import type { productInput, productPatch, settingsInput, variationInput, variationPatch, variationsBulkInput } from "./store.logic";
import {
  DEFAULT_LOW_STOCK,
  MAX_VARIATIONS,
  allCombinations,
  descendantsOf,
  filterAndSort,
  isSoldOut,
  labelsOf,
  normalizeSearch,
  priceSummary,
  readAttrs,
  readVariationAttrs,
  resolveAttrs,
  signatureOf,
  slugify,
  stockSource,
  uniqueSlug,
  validVariationAttrs,
  effectivePrice,
  variationSale,
  type GlobalAttrInfo,
  type ListItem,
  type ProductAttr,
  type ResolvedAttr,
  type SortKey,
  type VariationRow,
  SORTS,
} from "./store-catalog.logic";
import { normalizeCode, phoneKey, priceLines, quoteCart, stockToReturn, soldOutMessage, type CouponRule, type DeliveryConfig, type ProductForPricing, type Quote, type TaxConfig } from "./store-pricing.logic";
import type { ShippingService } from "./shipping/shipping.service";
import { pickOption, shippingOptions, type OptionsResult, type ShippingOption } from "./shipping/shipping.logic";
import { lookInput, mergeLook, readLook } from "./store-look.logic";
import { StoreRepository } from "./store.repository";
import { StoreCatalogRepository } from "./store-catalog.repository";
import { StoreCatalogService, bannerUrl, categoryImageUrl, termImageUrl } from "./store-catalog.service";

const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? null : Number(v));
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// روابط الصور العامة (نسبية - الفرونت بيحط قبلها عنوان الـ API)
export const photoUrl = (slug: string, id: string) => `/api/public/store/${slug}/photo/${id}`;
const assetUrl = (slug: string, kind: "logo" | "cover", dataUrl: string | null) => (dataUrl ? `/api/public/store/${slug}/${kind}?v=${hash(dataUrl)}` : null);

type SettingsRow = Awaited<ReturnType<StoreRepository["settings"]>>;
type ProductRow = NonNullable<Awaited<ReturnType<StoreRepository["product"]>>>;
type OrderRow = NonNullable<Awaited<ReturnType<StoreRepository["order"]>>>;
type VariationDb = ProductRow["variations"][number];

function deliveryConfig(s: SettingsRow): DeliveryConfig {
  return {
    deliveryEnabled: s.deliveryEnabled,
    deliveryFee: Number(s.deliveryFee),
    freeDeliveryOver: num(s.freeDeliveryOver),
    areas: readAreas(s.deliveryAreas),
    pickupEnabled: s.pickupEnabled,
  };
}
function taxConfig(s: SettingsRow): TaxConfig {
  return { enabled: s.taxEnabled, rate: Number(s.taxRate), inclusive: s.pricesIncludeTax, onShipping: s.taxOnShipping, label: s.taxLabel };
}

function variationRow(v: VariationDb): VariationRow {
  return {
    id: v.id,
    attrs: readVariationAttrs(v.attrs),
    price: num(v.price),
    salePrice: num(v.salePrice),
    saleStart: v.saleStart,
    saleEnd: v.saleEnd,
    sku: v.sku,
    stock: v.stock,
    photoId: v.photoId,
    enabled: v.enabled,
    sortOrder: v.sortOrder,
  };
}
function saleOf(p: ProductRow) {
  return { price: Number(p.price), salePrice: num(p.salePrice), saleStart: p.saleStart, saleEnd: p.saleEnd };
}
function cardInput(p: ProductRow) {
  return { ...saleOf(p), id: p.id, type: p.type, stock: p.stock, backorders: p.backorders, variations: p.variations.map(variationRow) };
}

type ShipState = { result: OptionsResult | null; selected: ShippingOption | null; error: string | null; needsAddress: boolean };

// حماية بسيطة من الإزعاج: عدد الطلبات من نفس الـ IP في 10 دقايق
const orderHits = new Map<string, number[]>();
export function tooManyOrders(ip: string, limit = Number(process.env.STORE_ORDERS_PER_10MIN) || 20): boolean {
  const now = Date.now();
  const list = (orderHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  orderHits.set(ip, list);
  if (orderHits.size > 5000) for (const [k, v] of orderHits) if (!v.some((t) => now - t < 10 * 60_000)) orderHits.delete(k);
  return list.length > limit;
}

export class StoreService {
  readonly catalog: StoreCatalogService;
  constructor(
    private readonly repo: StoreRepository,
    readonly catalogRepo: StoreCatalogRepository,
    // طرق الشحن + شركات الشحن (اختياري: من غيره = التوصيل القديم بس)
    private readonly shipping?: ShippingService
  ) {
    this.catalog = new StoreCatalogService(catalogRepo);
  }

  // ====================== التاجر: الإعدادات ======================
  async getSettings(tenantId: string) {
    const [s, tenant] = await Promise.all([this.repo.settings(tenantId), this.repo.tenant(tenantId)]);
    return this.settingsView(s, tenant?.slug ?? "", tenant?.name ?? "");
  }

  private settingsView(s: SettingsRow, slug: string, tenantName: string) {
    const { logoDataUrl, coverDataUrl, deliveryAreas, deliveryFee, freeDeliveryOver, taxRate, look, ...rest } = s;
    return {
      ...rest,
      slug,
      tenantName,
      deliveryFee: Number(deliveryFee),
      freeDeliveryOver: num(freeDeliveryOver),
      deliveryAreas: readAreas(deliveryAreas),
      taxRate: Number(taxRate),
      look: readLook(look, s.template),
      logoUrl: assetUrl(slug, "logo", logoDataUrl),
      coverUrl: assetUrl(slug, "cover", coverDataUrl),
    };
  }

  async saveSettings(tenantId: string, input: z.infer<typeof settingsInput>) {
    const { deliveryAreas, ...rest } = input;
    const data: Prisma.StoreSettingsUpdateInput = { ...rest };
    if (deliveryAreas !== undefined) data.deliveryAreas = deliveryAreas.length ? (deliveryAreas as Prisma.InputJsonValue) : Prisma.DbNull;
    await this.repo.saveSettings(tenantId, data);
    return this.getSettings(tenantId);
  }

  async saveLook(tenantId: string, input: z.infer<typeof lookInput>) {
    const s = await this.repo.settings(tenantId);
    const template = input.template ?? s.template;
    const look = mergeLook(readLook(s.look, s.template), template, input);
    await this.repo.saveSettings(tenantId, { template, look: look as unknown as Prisma.InputJsonValue });
    return this.getSettings(tenantId);
  }

  private async slug(tenantId: string) {
    return (await this.repo.tenant(tenantId))?.slug ?? "";
  }

  // ====================== التاجر: المنتجات ======================
  private productView(p: ProductRow, slug: string, globals: Map<string, GlobalAttrInfo>, now = new Date()) {
    const attrs = readAttrs(p.attributes);
    const resolved = resolveAttrs(attrs, globals);
    const sale = saleOf(p);
    return {
      id: p.id,
      type: p.type,
      name: p.name,
      slug: p.slug,
      shortDescription: p.shortDescription,
      description: p.description,
      categoryId: p.categoryId,
      categoryIds: p.categoryIds,
      tagIds: p.tagIds,
      ...sale,
      sku: p.sku,
      stock: p.stock,
      lowStockAt: p.lowStockAt,
      backorders: p.backorders,
      attributes: attrs,
      weightKg: num(p.weightKg),
      lengthCm: num(p.lengthCm),
      widthCm: num(p.widthCm),
      heightCm: num(p.heightCm),
      relatedIds: p.relatedIds,
      upsellIds: p.upsellIds,
      purchaseNote: p.purchaseNote,
      status: p.status,
      active: p.active,
      featured: p.featured,
      soldCount: p.soldCount,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      photos: p.photos.map((ph) => ({ id: ph.id, url: photoUrl(slug, ph.id) })),
      variations: p.variations.map((v) => {
        const row = variationRow(v);
        const e = effectivePrice(variationSale(sale, row), now);
        return { ...row, labels: labelsOf(resolved, row.attrs), valid: validVariationAttrs(resolved, row.attrs), currentPrice: e.price, onSale: e.onSale };
      }),
      summary: priceSummary(cardInput(p), now),
    };
  }

  async products(tenantId: string) {
    const [list, slug, globals] = await Promise.all([this.repo.products(tenantId), this.slug(tenantId), this.catalog.globals(tenantId)]);
    return list.map((p) => this.productView(p, slug, globals));
  }

  async product(tenantId: string, id: string) {
    const p = await this.repo.product(tenantId, id);
    if (!p) throw new NotFoundError("Product not found");
    const [slug, globals] = await Promise.all([this.slug(tenantId), this.catalog.globals(tenantId)]);
    return this.productView(p, slug, globals);
  }

  // كل الـ ids اللي جاية من العميل لازم تبقى بتاعة الشركة دي
  private async checkRefs(tenantId: string, input: { categoryIds?: string[]; tagIds?: string[]; relatedIds?: string[]; upsellIds?: string[]; attributes?: ProductAttr[] }, selfId: string | null) {
    if (input.categoryIds?.length) {
      const cats = await this.catalogRepo.categories(tenantId);
      if (!input.categoryIds.every((id) => cats.some((c) => c.id === id))) throw new AppError(400, "BAD_CATEGORY", "One of the chosen categories doesn't exist.");
    }
    if (input.tagIds?.length) {
      const found = await this.catalogRepo.tagsByIds(tenantId, input.tagIds);
      if (found.length !== input.tagIds.length) throw new AppError(400, "BAD_TAG", "One of the chosen tags doesn't exist.");
    }
    for (const key of ["relatedIds", "upsellIds"] as const) {
      const list = input[key];
      if (!list?.length) continue;
      if (selfId && list.includes(selfId)) throw new AppError(400, "BAD_PRODUCT", "A product can't be linked to itself.");
      const found = await this.repo.productRefs(tenantId, list);
      if (found.length !== list.length) throw new AppError(400, "BAD_PRODUCT", "One of the linked products doesn't exist.");
    }
    if (input.attributes?.length) {
      const globals = await this.catalog.globals(tenantId);
      for (const a of input.attributes) {
        if (!a.attributeId) continue;
        const g = globals.get(a.attributeId);
        if (!g) throw new AppError(400, "BAD_ATTRIBUTE", "One of the chosen attributes doesn't exist.");
        if (!a.termIds.every((t) => g.terms.some((x) => x.id === t))) throw new AppError(400, "BAD_TERM", `One of the values of ${g.name} doesn't exist.`);
      }
    }
  }

  private async productSlug(tenantId: string, wanted: string, selfId: string | null) {
    const taken = (await this.repo.productSlugs(tenantId)).filter((p) => p.id !== selfId).map((p) => p.slug!);
    return uniqueSlug(slugify(wanted, "product"), taken);
  }

  // الحقول المشتركة بين الإضافة والتعديل (بما فيها الشكل القديم: comparePrice / active / categoryId)
  private productData(input: Partial<z.infer<typeof productInput>>, current: { price: number; salePrice: number | null } | null) {
    const data: Record<string, unknown> = {};
    const copy = ["name", "type", "shortDescription", "description", "salePrice", "saleStart", "saleEnd", "sku", "stock", "lowStockAt", "backorders", "weightKg", "lengthCm", "widthCm", "heightCm", "relatedIds", "upsellIds", "purchaseNote", "featured"] as const;
    for (const k of copy) if (input[k] !== undefined) data[k] = input[k];
    if (input.price !== undefined) data.price = input.price;
    // شكل قديم: "السعر القديم" أعلى من السعر = السعر العادي، والسعر = التخفيض
    if (input.comparePrice !== undefined && input.salePrice === undefined) {
      const price = input.price ?? current?.price ?? 0;
      if (input.comparePrice != null && input.comparePrice > price) {
        data.price = input.comparePrice;
        data.salePrice = price;
      } else data.salePrice = null;
    }
    if (input.categoryIds !== undefined) {
      data.categoryIds = input.categoryIds;
      data.categoryId = input.categoryIds[0] ?? null;
    } else if (input.categoryId !== undefined) {
      data.categoryIds = input.categoryId ? [input.categoryId] : [];
      data.categoryId = input.categoryId;
    }
    if (input.tagIds !== undefined) data.tagIds = input.tagIds;
    if (input.attributes !== undefined) data.attributes = input.attributes.length ? (input.attributes as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
    const status = input.status ?? (input.active === undefined ? undefined : input.active ? "PUBLISHED" : "DRAFT");
    if (status) {
      data.status = status;
      data.active = status !== "DRAFT";
    }
    return data;
  }

  async createProduct(tenantId: string, input: z.infer<typeof productInput>) {
    if ((await this.repo.countProducts(tenantId)) >= MAX_PRODUCTS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_PRODUCTS} products per shop.`);
    if (input.categoryId && !input.categoryIds) input = { ...input, categoryIds: [input.categoryId] };
    await this.checkRefs(tenantId, input, null);
    const data = this.productData(input, null);
    const created = await this.repo.createProduct(tenantId, {
      ...(data as Omit<Prisma.StoreProductUncheckedCreateInput, "tenantId" | "name" | "price">),
      name: input.name,
      price: (data.price as number) ?? input.price,
      slug: await this.productSlug(tenantId, input.slug || input.name, null),
      type: input.type ?? "simple",
      status: (data.status as string) ?? "PUBLISHED",
      active: (data.active as boolean) ?? true,
    });
    return this.product(tenantId, created.id);
  }

  async updateProduct(tenantId: string, id: string, input: z.infer<typeof productPatch>) {
    const current = await this.repo.product(tenantId, id);
    if (!current) throw new NotFoundError("Product not found");
    await this.checkRefs(tenantId, input, id);
    const data = this.productData(input, { price: Number(current.price), salePrice: num(current.salePrice) });
    // سعر التخفيض لازم يفضل أقل من العادي بعد التعديل
    const price = (data.price as number | undefined) ?? Number(current.price);
    const sale = data.salePrice !== undefined ? (data.salePrice as number | null) : num(current.salePrice);
    if (sale != null && !(sale < price)) throw new AppError(400, "BAD_SALE_PRICE", "The sale price must be lower than the regular price (or leave it empty)");
    const start = data.saleStart !== undefined ? (data.saleStart as Date | null) : current.saleStart;
    const end = data.saleEnd !== undefined ? (data.saleEnd as Date | null) : current.saleEnd;
    if (start && end && !(end > start)) throw new AppError(400, "BAD_SALE_DATES", "The sale must end after it starts");
    if (input.slug !== undefined || !current.slug) data.slug = await this.productSlug(tenantId, input.slug || input.name || current.name, id);
    await this.repo.updateProduct(tenantId, id, data as Prisma.StoreProductUncheckedUpdateManyInput);
    // الخصائص اتغيرت: الاختيارات اللي مبقتش صح بتتمسح (مبقتش تنفع تتطلب أصلًا)
    if (input.attributes !== undefined) {
      const globals = await this.catalog.globals(tenantId);
      const resolved = resolveAttrs(input.attributes, globals);
      const keep = current.variations.filter((v) => validVariationAttrs(resolved, readVariationAttrs(v.attrs))).map((v) => v.id);
      if (keep.length !== current.variations.length) await this.catalogRepo.deleteVariationsNotIn(tenantId, id, keep);
    }
    return this.product(tenantId, id);
  }

  async deleteProduct(tenantId: string, id: string) {
    const r = await this.repo.deleteProduct(tenantId, id);
    if (r.count === 0) throw new NotFoundError("Product not found");
  }

  async duplicateProduct(tenantId: string, id: string) {
    const p = await this.repo.product(tenantId, id);
    if (!p) throw new NotFoundError("Product not found");
    if ((await this.repo.countProducts(tenantId)) >= MAX_PRODUCTS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_PRODUCTS} products per shop.`);
    const name = `${p.name} (copy)`.slice(0, 120);
    const copy = await this.repo.createProduct(tenantId, {
      name,
      slug: await this.productSlug(tenantId, name, null),
      type: p.type,
      shortDescription: p.shortDescription,
      description: p.description,
      categoryId: p.categoryId,
      categoryIds: p.categoryIds,
      tagIds: p.tagIds,
      price: p.price,
      salePrice: p.salePrice,
      saleStart: p.saleStart,
      saleEnd: p.saleEnd,
      sku: null,
      stock: p.stock,
      lowStockAt: p.lowStockAt,
      backorders: p.backorders,
      attributes: p.attributes ?? Prisma.DbNull,
      weightKg: p.weightKg,
      lengthCm: p.lengthCm,
      widthCm: p.widthCm,
      heightCm: p.heightCm,
      relatedIds: p.relatedIds,
      upsellIds: p.upsellIds,
      purchaseNote: p.purchaseNote,
      // النسخة بتبدأ مسودة لحد ما التاجر يعدّلها
      status: "DRAFT",
      active: false,
      featured: false,
    });
    const photos = await this.repo.photosWithData(tenantId, id);
    if (photos.length) await this.repo.copyPhotos(tenantId, copy.id, photos);
    if (p.variations.length)
      await this.catalogRepo.createVariations(
        tenantId,
        copy.id,
        p.variations.map((v) => ({ attrs: readVariationAttrs(v.attrs), signature: v.signature, price: num(v.price), stock: v.stock }))
      );
    return this.product(tenantId, copy.id);
  }

  async orderProducts(tenantId: string, ids: string[]) {
    await this.repo.orderProducts(tenantId, ids);
  }

  // ---------- الصور ----------
  async addPhoto(tenantId: string, productId: string, dataUrl: string) {
    if (!(await this.repo.product(tenantId, productId))) throw new NotFoundError("Product not found");
    if ((await this.repo.photoCount(tenantId, productId)) >= MAX_PHOTOS) throw new AppError(400, "TOO_MANY_PHOTOS", `Up to ${MAX_PHOTOS} photos per product.`);
    await this.repo.addPhoto(tenantId, productId, dataUrl);
    return this.product(tenantId, productId);
  }
  async deletePhoto(tenantId: string, productId: string, photoId: string) {
    const r = await this.repo.deletePhoto(tenantId, productId, photoId);
    if (r.count === 0) throw new NotFoundError("Photo not found");
    await this.catalogRepo.clearVariationPhoto(tenantId, productId, photoId);
    return this.product(tenantId, productId);
  }
  async orderPhotos(tenantId: string, productId: string, ids: string[]) {
    if (!(await this.repo.product(tenantId, productId))) throw new NotFoundError("Product not found");
    await this.repo.orderPhotos(tenantId, productId, ids);
    return this.product(tenantId, productId);
  }

  // ---------- الاختيارات (variations) ----------
  private async variableContext(tenantId: string, productId: string) {
    const p = await this.repo.product(tenantId, productId);
    if (!p) throw new NotFoundError("Product not found");
    const resolved = resolveAttrs(readAttrs(p.attributes), await this.catalog.globals(tenantId));
    return { p, resolved };
  }

  // "اعمل كل التوافيق": بيضيف الناقص بس (والموجود بيفضل بسعره ومخزونه)
  async generateVariations(tenantId: string, productId: string) {
    const { p, resolved } = await this.variableContext(tenantId, productId);
    if (p.type !== "variable") throw new AppError(400, "NOT_VARIABLE", "Switch the product to “has choices” first.");
    const combos = allCombinations(resolved);
    if (combos.length === 0) throw new AppError(400, "NO_VARIATION_ATTRS", "Add an attribute and tick “Use for choices” first (e.g. Size: S, M, L).");
    const have = new Set(p.variations.map((v) => v.signature));
    const missing = combos.filter((c) => !have.has(signatureOf(c)));
    if (p.variations.length + missing.length > MAX_VARIATIONS)
      throw new AppError(400, "TOO_MANY_VARIATIONS", `That makes ${p.variations.length + missing.length} choices — the limit is ${MAX_VARIATIONS}. Use fewer values.`);
    if (missing.length) await this.catalogRepo.createVariations(tenantId, productId, missing.map((attrs) => ({ attrs, signature: signatureOf(attrs) })));
    return { added: missing.length, product: await this.product(tenantId, productId) };
  }

  private async checkVariationFields(tenantId: string, productId: string, input: { photoId?: string | null; price?: number | null; salePrice?: number | null; saleStart?: Date | null; saleEnd?: Date | null }, current: { price: number | null; salePrice: number | null } | null, productPrice: number) {
    if (input.photoId) {
      const photos = await this.repo.photosMeta(tenantId, productId);
      if (!photos.some((ph) => ph.id === input.photoId)) throw new AppError(400, "BAD_PHOTO", "Pick one of this product's photos.");
    }
    const price = (input.price !== undefined ? input.price : current?.price) ?? productPrice;
    const sale = input.salePrice !== undefined ? input.salePrice : current?.salePrice ?? null;
    if (sale != null && !(sale < price)) throw new AppError(400, "BAD_SALE_PRICE", "The sale price must be lower than the regular price (or leave it empty)");
    if (input.saleStart && input.saleEnd && !(input.saleEnd > input.saleStart)) throw new AppError(400, "BAD_SALE_DATES", "The sale must end after it starts");
  }

  async addVariation(tenantId: string, productId: string, input: z.infer<typeof variationInput>) {
    const { p, resolved } = await this.variableContext(tenantId, productId);
    if (p.type !== "variable") throw new AppError(400, "NOT_VARIABLE", "Switch the product to “has choices” first.");
    if (!validVariationAttrs(resolved, input.attrs)) throw new AppError(400, "BAD_VARIATION", "Pick one value for every choice attribute.");
    if (p.variations.length >= MAX_VARIATIONS) throw new AppError(400, "TOO_MANY_VARIATIONS", `Up to ${MAX_VARIATIONS} choices per product.`);
    const sig = signatureOf(input.attrs);
    if (p.variations.some((v) => v.signature === sig)) throw new AppError(409, "DUPLICATE", "That choice already exists.");
    await this.checkVariationFields(tenantId, productId, input, null, Number(p.price));
    await this.catalogRepo.createVariations(tenantId, productId, [{ attrs: input.attrs, signature: sig }]);
    const created = (await this.catalogRepo.variations(tenantId, productId)).find((v) => v.signature === sig)!;
    const { attrs: _a, ...rest } = input;
    void _a;
    await this.catalogRepo.updateVariation(tenantId, productId, created.id, rest);
    return this.product(tenantId, productId);
  }

  async updateVariation(tenantId: string, productId: string, variationId: string, input: z.infer<typeof variationPatch>) {
    const { p, resolved } = await this.variableContext(tenantId, productId);
    const v = p.variations.find((x) => x.id === variationId);
    if (!v) throw new NotFoundError("Choice not found");
    await this.checkVariationFields(tenantId, productId, input, { price: num(v.price), salePrice: num(v.salePrice) }, Number(p.price));
    const { attrs, ...rest } = input;
    const data: Prisma.StoreProductVariationUpdateManyMutationInput = { ...rest };
    if (attrs) {
      if (!validVariationAttrs(resolved, attrs)) throw new AppError(400, "BAD_VARIATION", "Pick one value for every choice attribute.");
      const sig = signatureOf(attrs);
      if (p.variations.some((x) => x.id !== variationId && x.signature === sig)) throw new AppError(409, "DUPLICATE", "That choice already exists.");
      data.attrs = attrs;
      data.signature = sig;
    }
    await this.catalogRepo.updateVariation(tenantId, productId, variationId, data);
    return this.product(tenantId, productId);
  }

  async bulkVariations(tenantId: string, productId: string, input: z.infer<typeof variationsBulkInput>) {
    const p = await this.repo.product(tenantId, productId);
    if (!p) throw new NotFoundError("Product not found");
    const ids = input.ids.filter((id) => p.variations.some((v) => v.id === id));
    if (ids.length === 0) throw new NotFoundError("Choice not found");
    const data: Prisma.StoreProductVariationUpdateManyMutationInput = {};
    if (input.price !== undefined) data.price = input.price;
    if (input.salePrice !== undefined) data.salePrice = input.salePrice;
    if (input.stock !== undefined) data.stock = input.stock;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    // التخفيض لازم يفضل أقل من السعر في كل اختيار
    for (const id of ids) {
      const v = p.variations.find((x) => x.id === id)!;
      const price = (input.price !== undefined ? input.price : num(v.price)) ?? Number(p.price);
      const sale = input.salePrice !== undefined ? input.salePrice : num(v.salePrice);
      if (sale != null && !(sale < price)) throw new AppError(400, "BAD_SALE_PRICE", "The sale price must be lower than the regular price of every chosen item.");
    }
    if (Object.keys(data).length) await this.catalogRepo.updateVariations(tenantId, productId, ids, data);
    if (input.stockAdd) await this.catalogRepo.updateVariations(tenantId, productId, ids.filter((id) => p.variations.find((v) => v.id === id)!.stock != null), { stock: { increment: input.stockAdd } });
    return this.product(tenantId, productId);
  }

  async deleteVariation(tenantId: string, productId: string, variationId: string) {
    const r = await this.catalogRepo.deleteVariation(tenantId, productId, variationId);
    if (r.count === 0) throw new NotFoundError("Choice not found");
    return this.product(tenantId, productId);
  }

  // ====================== الطلبات ======================
  async orders(tenantId: string, status?: string) {
    const tz = await this.repo.timezone(tenantId);
    const todayKey = todayKeyInTimezone(tz);
    const todayStart = zonedDateHourToUtc(todayKey, 0, tz);
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600_000);
    const [orders, stats, slug] = await Promise.all([this.repo.orders(tenantId, status), this.repo.orderStats(tenantId, todayStart, weekStart), this.slug(tenantId)]);
    const shipments = this.shipping ? await this.shipping.shipmentsFor(tenantId, orders.map((o) => o.id)) : new Map();
    return { orders: orders.map((o) => ({ ...this.orderView(o, slug), shipment: shipments.get(o.id) ?? null })), stats };
  }

  private orderView(o: OrderRow, slug: string) {
    const items = (Array.isArray(o.items) ? o.items : []) as unknown as { photoId?: string | null }[];
    return {
      ...o,
      items: items.map((l) => ({ ...l, photoUrl: l.photoId ? photoUrl(slug, l.photoId) : null })),
      subtotal: Number(o.subtotal),
      deliveryFee: Number(o.deliveryFee),
      discount: Number(o.discount),
      tax: Number(o.tax),
      total: Number(o.total),
      payableAmount: num(o.payableAmount),
      reference: shortReference(o.id),
    };
  }

  async order(tenantId: string, id: string) {
    const o = await this.repo.order(tenantId, id);
    if (!o) throw new NotFoundError("Order not found");
    const shipment = this.shipping ? await this.shipping.shipmentView(tenantId, id) : null;
    return { ...this.orderView(o, await this.slug(tenantId)), shipment };
  }

  async updateOrder(tenantId: string, id: string, input: { status?: OrderStatus; trackingUrl?: string | null; note?: string | null; merchantNote?: string | null }) {
    const o = await this.repo.order(tenantId, id);
    if (!o) throw new NotFoundError("Order not found");
    if (input.status && !canChangeStatus(o.status, input.status)) throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled and can't be changed.");
    const { status, ...rest } = input;
    if (status === "CANCELLED" && o.status !== "CANCELLED") {
      // الإلغاء بيرجّع المخزون (للاختيار أو المنتج) والكوبون مرة واحدة بس (حتى لو اتداس مرتين في نفس اللحظة)
      await this.repo.transaction(async (tx) => {
        const claimed = await this.repo.claimOrder(tx, tenantId, id, { status: { not: "CANCELLED" } }, { status: "CANCELLED", ...rest });
        if (claimed.count === 0) return;
        const back = stockToReturn(o.items);
        for (const [productId, qty] of back.products) await this.repo.returnStock(tx, tenantId, productId, qty);
        for (const [variationId, qty] of back.variations) await this.repo.returnVariationStock(tx, tenantId, variationId, qty);
        if (o.couponId) await this.catalogRepo.releaseCoupon(tx, tenantId, o.couponId, o.id);
      });
    } else {
      await this.repo.updateOrder(tenantId, id, { ...(status ? { status } : {}), ...rest });
    }
    return this.order(tenantId, id);
  }

  async markPaid(tenantId: string, id: string) {
    const o = await this.repo.order(tenantId, id);
    if (!o) throw new NotFoundError("Order not found");
    if (o.status === "CANCELLED") throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled.");
    if (o.paymentStatus !== "PAID") await this.repo.updateOrder(tenantId, id, { paymentStatus: "PAID" });
    return this.order(tenantId, id);
  }

  // ====================== المتجر العام ======================
  // الشركة بالـ slug - والمتجر شغال بس لو الاشتراك فعلي (مش تجربة)
  async liveTenant(slug: string) {
    const tenant = await this.repo.tenantBySlug(slug);
    if (!tenant || !(await isModuleLive(tenant, "store"))) throw new NotFoundError("Shop not found");
    return tenant;
  }

  // كل اللي محتاجينه لعرض المنتجات (مرة واحدة لكل طلب)
  private async publicContext(tenantId: string) {
    const [products, globals, categories, catImages, termImages] = await Promise.all([
      this.repo.products(tenantId, ["PUBLISHED", "HIDDEN"]),
      this.catalog.globals(tenantId),
      this.catalogRepo.categories(tenantId),
      this.catalogRepo.categoryImageTags(tenantId),
      this.catalogRepo.termImageTags(tenantId),
    ]);
    return { products, globals, categories, catImages, termImages };
  }

  private cardView(p: ProductRow, slug: string, globals: Map<string, GlobalAttrInfo>, now: Date) {
    const s = priceSummary(cardInput(p), now);
    const resolved = resolveAttrs(readAttrs(p.attributes), globals);
    // دواير الألوان على الكارت (أول خاصية لون في الاختيارات)
    const colorAttr = resolved.find((a) => a.display === "color" && a.forVariations) ?? resolved.find((a) => a.display === "color");
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: p.type,
      categoryIds: p.categoryIds,
      minPrice: s.minPrice,
      maxPrice: s.maxPrice,
      minRegular: s.minRegular,
      maxRegular: s.maxRegular,
      onSale: s.onSale,
      discountPct: s.maxDiscountPct,
      soldOut: s.soldOut,
      lowStock: !s.soldOut && s.stockLeft != null && s.stockLeft > 0 && s.stockLeft <= (p.lowStockAt ?? 5) ? s.stockLeft : null,
      featured: p.featured,
      hasOptions: p.type === "variable",
      createdAt: p.createdAt,
      photoUrl: p.photos[0] ? photoUrl(slug, p.photos[0].id) : null,
      photoUrl2: p.photos[1] ? photoUrl(slug, p.photos[1].id) : null,
      swatches: colorAttr ? colorAttr.options.slice(0, 6).map((o) => ({ name: o.label, color: o.color })) : [],
    };
  }

  private listItems(products: ProductRow[], globals: Map<string, GlobalAttrInfo>, tags: Map<string, string>, now: Date): ListItem[] {
    return products.map((p) => {
      const attrs = readAttrs(p.attributes);
      const resolved = resolveAttrs(attrs, globals);
      const termIds = resolved.filter((a) => a.attributeId && (a.visible || a.forVariations)).flatMap((a) => a.options.map((o) => o.id));
      const words = [p.name, p.sku ?? "", ...p.variations.map((v) => v.sku ?? ""), ...p.tagIds.map((t) => tags.get(t) ?? ""), ...resolved.flatMap((a) => a.options.map((o) => o.label))];
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        categoryIds: p.categoryIds,
        tagIds: p.tagIds,
        termIds,
        featured: p.featured,
        sortOrder: p.sortOrder,
        createdAt: p.createdAt,
        soldCount: p.soldCount,
        summary: priceSummary(cardInput(p), now),
        searchText: normalizeSearch(words.join(" ")),
      };
    });
  }

  private categoryTree(categories: { id: string; parentId: string | null; name: string; slug: string | null; description: string | null }[], counts: Map<string, number>, slug: string, images: Map<string, string>) {
    return categories.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      name: c.name,
      slug: c.slug,
      description: c.description,
      imageUrl: images.has(c.id) ? categoryImageUrl(slug, c.id, images.get(c.id)!) : null,
      // عدد المنتجات المنشورة فيه + في اللي تحته
      count: counts.get(c.id) ?? 0,
    }));
  }

  async shop(slug: string) {
    const tenant = await this.liveTenant(slug);
    const now = new Date();
    const [s, ctx, tags, banners, methods, rates, coupons] = await Promise.all([
      this.repo.settings(tenant.id),
      this.publicContext(tenant.id),
      this.catalogRepo.tags(tenant.id),
      this.catalogRepo.banners(tenant.id),
      getTenantPaymentMethods(tenant.id),
      getRates(),
      this.catalogRepo.coupons(tenant.id),
    ]);
    const listed = ctx.products.filter((p) => p.status === "PUBLISHED");
    const tagNames = new Map(tags.map((t) => [t.id, t.name]));
    const items = this.listItems(listed, ctx.globals, tagNames, now);
    const counts = new Map<string, number>();
    for (const c of ctx.categories) counts.set(c.id, items.filter((it) => it.categoryIds.some((id) => descendantsOf(ctx.categories, c.id).has(id))).length);
    const card = (id: string) => this.cardView(listed.find((p) => p.id === id)!, slug, ctx.globals, now);
    const pick = (list: ListItem[], n: number) => list.slice(0, n).map((it) => card(it.id));
    const available = items.filter((it) => !it.summary.soldOut);
    // الفلاتر: الخصائص العامة + القيم المستخدمة فعلًا في منتجات منشورة
    const used = new Map<string, number>();
    for (const it of items) for (const t of it.termIds) used.set(t, (used.get(t) ?? 0) + 1);
    const filters = [...ctx.globals.values()]
      .map((g) => ({
        id: g.id,
        name: g.name,
        slug: g.slug,
        display: g.display,
        terms: g.terms.filter((t) => used.has(t.id)).map((t) => ({ id: t.id, name: t.name, slug: t.slug, color: t.color, imageUrl: t.hasImage ? termImageUrl(slug, t.id, ctx.termImages.get(t.id)!) : null, count: used.get(t.id)! })),
      }))
      .filter((g) => g.terms.length > 0);
    const prices = items.map((it) => it.summary.minPrice).concat(items.map((it) => it.summary.maxPrice));
    const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
    const look = readLook(s.look, s.template);
    return {
      slug,
      brandName: s.brandName || tenant.name,
      tagline: s.tagline,
      about: s.about,
      accentColor: s.accentColor,
      template: s.template,
      look,
      logoUrl: assetUrl(slug, "logo", s.logoDataUrl),
      coverUrl: assetUrl(slug, "cover", s.coverDataUrl),
      banners: banners.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, buttonText: b.buttonText, link: b.link, imageUrl: bannerUrl(slug, b.id, b.createdAt) })),
      contact: { whatsapp: s.whatsapp, phone: s.phone, email: s.email, instagram: s.instagram, address: s.address },
      delivery: { enabled: s.deliveryEnabled, fee: Number(s.deliveryFee), freeOver: num(s.freeDeliveryOver), areas: readAreas(s.deliveryAreas) },
      pickup: { enabled: s.pickupEnabled, address: s.pickupAddress },
      shipping: this.shipping ? this.shipping.publicMethods(s) : null,
      tax: { enabled: s.taxEnabled && Number(s.taxRate) > 0, rate: Number(s.taxRate), inclusive: s.pricesIncludeTax, label: s.taxLabel || "VAT" },
      hasCoupons: coupons.some((c) => c.active && (!c.expiresAt || c.expiresAt > now)),
      currency,
      rate: rateFor(currency, rates),
      paymentMethods: publicPaymentMethods(methods),
      categories: this.categoryTree(ctx.categories, counts, slug, ctx.catImages).filter((c) => c.count > 0),
      tags: tags.filter((t) => items.some((it) => it.tagIds.includes(t.id))).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
      filters,
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 },
      productCount: items.length,
      sections: {
        featured: pick(filterAndSort(available.filter((it) => it.featured), { sort: "featured" }), 8),
        newest: pick(filterAndSort(items, { sort: "newest", inStock: true }), 8),
        onSale: pick(filterAndSort(items, { onSale: true, inStock: true, sort: "featured" }), 8),
        popular: pick(filterAndSort(items, { sort: "popular", inStock: true }), 8),
      },
    };
  }

  // قايمة المنتجات بالفلاتر والترتيب والبحث (صفحة القسم / كل المنتجات)
  async shopProducts(slug: string, q: { category?: string; tag?: string; terms?: string; min?: number | null; max?: number | null; inStock?: boolean; onSale?: boolean; q?: string; sort?: string; page?: number; limit?: number }) {
    const tenant = await this.liveTenant(slug);
    const now = new Date();
    const [ctx, tags] = await Promise.all([this.publicContext(tenant.id), this.catalogRepo.tags(tenant.id)]);
    const listed = ctx.products.filter((p) => p.status === "PUBLISHED");
    const items = this.listItems(listed, ctx.globals, new Map(tags.map((t) => [t.id, t.name])), now);
    let category: (typeof ctx.categories)[number] | null = null;
    if (q.category) {
      category = ctx.categories.find((c) => c.id === q.category || c.slug === q.category) ?? null;
      if (!category) throw new NotFoundError("Category not found");
    }
    const tag = q.tag ? tags.find((t) => t.id === q.tag || t.slug === q.tag) ?? null : null;
    // القيم مجمّعة بالخاصية: (أحمر أو أزرق) و (S)
    const termIds = (q.terms ?? "").split(",").filter(Boolean).slice(0, 50);
    const groups = new Map<string, string[]>();
    for (const t of termIds) {
      const g = [...ctx.globals.values()].find((a) => a.terms.some((x) => x.id === t));
      if (g) groups.set(g.id, [...(groups.get(g.id) ?? []), t]);
    }
    const sort = (SORTS as readonly string[]).includes(q.sort ?? "") ? (q.sort as SortKey) : category ? "featured" : "featured";
    const result = filterAndSort(items, {
      categoryIds: category ? descendantsOf(ctx.categories, category.id) : null,
      tagId: tag?.id ?? (q.tag ? "__none__" : null),
      terms: [...groups.values()],
      min: q.min ?? null,
      max: q.max ?? null,
      inStock: q.inStock,
      onSale: q.onSale,
      q: q.q,
      sort,
    });
    const limit = Math.min(Math.max(q.limit ?? 24, 1), 60);
    const pages = Math.max(1, Math.ceil(result.length / limit));
    const page = Math.min(Math.max(q.page ?? 1, 1), pages);
    const byId = new Map(listed.map((p) => [p.id, p]));
    // مسار القسم (الرئيسي > الفرعي) + الأقسام اللي تحته
    const trail: { id: string; name: string; slug: string | null }[] = [];
    for (let c = category; c; c = c.parentId ? ctx.categories.find((x) => x.id === c!.parentId) ?? null : null) trail.unshift({ id: c.id, name: c.name, slug: c.slug });
    const counts = new Map<string, number>();
    for (const c of ctx.categories) counts.set(c.id, items.filter((it) => it.categoryIds.some((id) => descendantsOf(ctx.categories, c.id).has(id))).length);
    return {
      total: result.length,
      page,
      pages,
      sort,
      items: result.slice((page - 1) * limit, page * limit).map((it) => this.cardView(byId.get(it.id)!, slug, ctx.globals, now)),
      category: category
        ? {
            id: category.id,
            name: category.name,
            slug: category.slug,
            description: category.description,
            imageUrl: ctx.catImages.has(category.id) ? categoryImageUrl(slug, category.id, ctx.catImages.get(category.id)!) : null,
            trail,
            children: this.categoryTree(ctx.categories.filter((c) => c.parentId === category!.id), counts, slug, ctx.catImages).filter((c) => c.count > 0),
          }
        : null,
      tag: tag ? { id: tag.id, name: tag.name, slug: tag.slug } : null,
    };
  }

  async shopProduct(slug: string, idOrSlug: string) {
    const tenant = await this.liveTenant(slug);
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
    const p = isId ? await this.repo.product(tenant.id, idOrSlug) : await this.repo.productBySlug(tenant.id, idOrSlug);
    if (!p || p.status === "DRAFT") throw new NotFoundError("Product not found");
    const now = new Date();
    const ctx = await this.publicContext(tenant.id);
    const tags = await this.catalogRepo.tags(tenant.id);
    const resolved = resolveAttrs(readAttrs(p.attributes), ctx.globals);
    const sale = saleOf(p);
    const s = priceSummary(cardInput(p), now);
    const optionImage = (o: ResolvedAttr["options"][number]) => (o.termId && o.hasImage ? termImageUrl(slug, o.termId, ctx.termImages.get(o.termId)!) : null);
    const variations =
      p.type === "variable"
        ? p.variations
            .filter((v) => v.enabled)
            .map((v) => {
              const row = variationRow(v);
              if (!validVariationAttrs(resolved, row.attrs)) return null;
              const e = effectivePrice(variationSale(sale, row), now);
              const src = stockSource(p, row);
              return {
                id: v.id,
                attrs: row.attrs,
                price: e.price,
                regularPrice: e.regular,
                onSale: e.onSale,
                saleEnds: e.saleEnds,
                soldOut: isSoldOut(p, row),
                stockLeft: p.backorders ? null : src.left,
                sku: row.sku || p.sku,
                photoUrl: row.photoId && p.photos.some((ph) => ph.id === row.photoId) ? photoUrl(slug, row.photoId) : null,
              };
            })
            .filter((x): x is NonNullable<typeof x> => !!x)
        : [];
    const simple = effectivePrice(sale, now);
    const listed = ctx.products.filter((x) => x.status === "PUBLISHED" && x.id !== p.id);
    // منتجات شبيهة: اللي اختارها التاجر، وبعدين من نفس القسم
    const related = [...p.relatedIds.map((id) => listed.find((x) => x.id === id)).filter((x): x is ProductRow => !!x)];
    for (const x of listed) {
      if (related.length >= 8) break;
      if (!related.includes(x) && x.categoryIds.some((c) => p.categoryIds.includes(c))) related.push(x);
    }
    const upsells = p.upsellIds.map((id) => listed.find((x) => x.id === id)).filter((x): x is ProductRow => !!x);
    const mainCat = ctx.categories.find((c) => c.id === p.categoryIds[0]);
    const trail: { id: string; name: string; slug: string | null }[] = [];
    for (let c = mainCat ?? null; c; c = c.parentId ? ctx.categories.find((x) => x.id === c!.parentId) ?? null : null) trail.unshift({ id: c.id, name: c.name, slug: c.slug });
    return {
      id: p.id,
      slug: p.slug,
      type: p.type,
      name: p.name,
      shortDescription: p.shortDescription,
      description: p.description,
      categoryIds: p.categoryIds,
      trail,
      tags: tags.filter((t) => p.tagIds.includes(t.id)).map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
      price: simple.price,
      regularPrice: simple.regular,
      onSale: p.type === "variable" ? s.onSale : simple.onSale,
      saleEnds: p.type === "variable" ? null : simple.saleEnds,
      minPrice: s.minPrice,
      maxPrice: s.maxPrice,
      minRegular: s.minRegular,
      maxRegular: s.maxRegular,
      sku: p.sku,
      soldOut: s.soldOut,
      stockLeft: p.backorders ? null : p.type === "variable" ? null : p.stock,
      lowStockAt: p.lowStockAt ?? 5,
      // الخصائص اللي بتتختار (لون/مقاس) - بالترتيب
      choices: resolved
        .filter((a) => a.forVariations && p.type === "variable")
        .map((a) => ({ key: a.key, name: a.name, display: a.display, options: a.options.map((o) => ({ id: o.id, label: o.label, color: o.color, imageUrl: optionImage(o) })) })),
      // مواصفات للعرض (الخامة...)
      specs: [
        ...resolved.filter((a) => a.visible && !(a.forVariations && p.type === "variable")).map((a) => ({ name: a.name, value: a.options.map((o) => o.label).join(", ") })),
        ...(p.weightKg != null ? [{ name: "Weight", value: `${Number(p.weightKg)} kg` }] : []),
        ...(p.lengthCm != null || p.widthCm != null || p.heightCm != null ? [{ name: "Dimensions", value: `${[p.lengthCm, p.widthCm, p.heightCm].map((x) => (x == null ? "—" : Number(x))).join(" × ")} cm` }] : []),
      ],
      variations,
      photos: p.photos.map((ph) => photoUrl(slug, ph.id)),
      photoIds: p.photos.map((ph) => ph.id),
      related: related.slice(0, 8).map((x) => this.cardView(x, slug, ctx.globals, now)),
      upsells: upsells.map((x) => this.cardView(x, slug, ctx.globals, now)),
    };
  }

  // الصور: من غير شرط الاشتراك (رابط بـ id عشوائي) عشان التاجر في التجربة يشوف صوره في اللوحة
  async image(slug: string, kind: "photo" | "logo" | "cover" | "banner" | "category" | "term", id?: string) {
    const tenant = await this.repo.tenantBySlug(slug);
    if (!tenant) throw new NotFoundError("Not found");
    let dataUrl: string | null = null;
    let tag = "";
    if (kind === "photo") {
      const ph = await this.repo.photoBytes(tenant.id, id ?? "");
      dataUrl = ph?.dataUrl ?? null;
      tag = ph ? `${ph.id}-${ph.createdAt.getTime()}` : "";
    } else if (kind === "banner") {
      const b = await this.catalogRepo.banner(tenant.id, id ?? "");
      dataUrl = b?.dataUrl ?? null;
      tag = b ? `${b.id}-${b.createdAt.getTime()}` : "";
    } else if (kind === "category") {
      dataUrl = (await this.catalogRepo.categoryImage(tenant.id, id ?? ""))?.imageDataUrl ?? null;
      tag = dataUrl ? hash(dataUrl) : "";
    } else if (kind === "term") {
      dataUrl = (await this.catalogRepo.termImage(tenant.id, id ?? ""))?.imageDataUrl ?? null;
      tag = dataUrl ? hash(dataUrl) : "";
    } else {
      const s = await this.repo.settings(tenant.id);
      dataUrl = kind === "logo" ? s.logoDataUrl : s.coverDataUrl;
      tag = dataUrl ? hash(dataUrl) : "";
    }
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) throw new NotFoundError("Not found");
    return { ...decoded, etag: `"${hash(tag)}"` };
  }

  // ---------- الحساب (نفس الحساب للعرض وللطلب) ----------
  private async pricingContext(tenantId: string, input: QuoteInput) {
    const ids = [...new Set(input.items.map((i) => i.productId))];
    const [rows, globals, categories, settings, money] = await Promise.all([
      this.repo.productsByIds(tenantId, ids),
      this.catalog.globals(tenantId),
      this.catalogRepo.categories(tenantId),
      this.repo.settings(tenantId),
      getTenantMoney(tenantId),
    ]);
    const products: ProductForPricing[] = rows
      .filter((p) => p.status !== "DRAFT")
      .map((p) => ({
        ...saleOf(p),
        id: p.id,
        name: p.name,
        type: p.type,
        sku: p.sku,
        stock: p.stock,
        backorders: p.backorders,
        active: p.active && p.status !== "DRAFT",
        categoryIds: p.categoryIds,
        coverPhotoId: p.photos[0]?.id ?? null,
        purchaseNote: p.purchaseNote,
        attrs: resolveAttrs(readAttrs(p.attributes), globals),
        variations: p.variations.map(variationRow),
      }));
    let coupon: CouponRule | null = null;
    if (input.couponCode && input.couponCode.trim()) {
      const c = await this.catalogRepo.couponByCode(tenantId, normalizeCode(input.couponCode));
      if (!c) throw new AppError(400, "COUPON_INVALID", "This code isn't valid.");
      const cats = new Set<string>();
      for (const id of c.categoryIds) for (const d of descendantsOf(categories, id)) cats.add(d);
      coupon = {
        id: c.id,
        code: c.code,
        kind: c.kind as CouponRule["kind"],
        amount: Number(c.amount),
        minSpend: num(c.minSpend),
        maxUses: c.maxUses,
        usedCount: c.usedCount,
        maxPerCustomer: c.maxPerCustomer,
        expiresAt: c.expiresAt,
        productIds: c.productIds,
        categoryIds: cats,
        freeShipping: c.freeShipping,
        active: c.active,
      };
    }
    const fmt = (usd: number) => formatUsdAs(usd, money.currency, money.rates);
    const weights = new Map(rows.map((p) => [p.id, num(p.weightKg)]));
    return { products, coupon, settings, money, fmt, weights };
  }

  // lenient = عرض السعر (السلة/الدفع): طريقة شحن مش متاحة مابتوقعش الحساب - بترجع الخيارات + السبب.
  // الطلب الفعلي (placeOrder) = مش lenient: لازم طريقة متاحة، وسعرها من هنا بس
  private async runQuote(tenantId: string, input: QuoteInput, now: Date, lenient = false) {
    const ctx = await this.pricingContext(tenantId, input);
    const uses = ctx.coupon && ctx.coupon.maxPerCustomer != null && input.customerPhone ? await this.catalogRepo.customerUses(tenantId, ctx.coupon.id, phoneKey(input.customerPhone)) : 0;
    const ship: ShipState = { result: null, selected: null, error: null, needsAddress: false };
    let shippingFee: ((goods: number, couponFree: boolean) => { fee: number; area: string | null; free: "coupon" | "threshold" | null }) | undefined;
    if (this.shipping) {
      const { methods } = this.shipping.methodsOf(ctx.settings);
      const dest = { country: input.country ?? null, city: input.city ?? null, area: input.area ?? null, postalCode: input.postalCode ?? null };
      // أسعار الشركات محتاجة قيمة البضاعة (للجمارك) قبل الحساب النهائي
      const declared = priceLines(input.items, ctx.products, now).subtotal;
      const carrierRates = await this.shipping.carrierRates(tenantId, ctx.settings, methods, { lines: input.items, weights: ctx.weights, dest, declaredUsd: declared });
      const pub = this.shipping.publicMethods(ctx.settings);
      ship.needsAddress = pub.needsAddress;
      const homeCountry = pub.homeCountry;
      shippingFee = (goods, couponFree) => {
        const result = shippingOptions(methods, dest, goods, couponFree, carrierRates, homeCountry);
        ship.result = result;
        try {
          const o = pickOption(result, input.shippingOptionId, input.fulfillment ?? null);
          ship.selected = o;
          return { fee: o.fee, area: o.area, free: o.free };
        } catch (e) {
          if (!lenient || !(e instanceof AppError)) throw e;
          ship.error = e.message;
          return { fee: 0, area: null, free: null };
        }
      };
    }
    const quote = quoteCart({
      shipping: shippingFee,
      lines: input.items,
      products: ctx.products,
      delivery: deliveryConfig(ctx.settings),
      tax: taxConfig(ctx.settings),
      fulfillment: input.fulfillment ?? "DELIVERY",
      area: input.area,
      coupon: ctx.coupon,
      customerUses: uses,
      now,
      fmt: ctx.fmt,
    });
    return { quote, ctx, ship };
  }

  private quoteView(q: Quote, slug: string, ship?: ShipState) {
    return {
      shipping: ship?.result
        ? {
            options: ship.result.options.map((o) => ({ id: o.id, type: o.type, label: o.label, fee: o.fee, free: o.free, estimate: o.estimate, carrier: o.carrier, needsArea: o.needsArea, fulfillment: o.fulfillment })),
            unavailable: ship.result.unavailable.map((u) => ({ id: u.methodId, label: u.label, reason: u.reason === "MIN_ORDER" ? "Your order is below the minimum" : u.reason })),
            selected: ship.selected?.id ?? null,
            fulfillment: ship.selected?.fulfillment ?? null,
            error: ship.error,
            needsAddress: ship.needsAddress,
          }
        : null,
      lines: q.lines.map((l) => ({ productId: l.productId, variationId: l.variationId, name: l.name, options: l.options, price: l.price, regularPrice: l.regularPrice, qty: l.qty, photoUrl: l.photoId ? photoUrl(slug, l.photoId) : null })),
      subtotal: q.subtotal,
      discount: q.discount,
      coupon: q.coupon ? { code: q.coupon.code, freeShipping: q.coupon.freeShipping } : null,
      deliveryFee: q.deliveryFee,
      freeDelivery: q.freeDelivery,
      area: q.area,
      tax: q.tax,
      taxIncluded: q.taxIncluded,
      taxLabel: q.taxLabel,
      taxRate: q.taxRate,
      total: q.total,
    };
  }

  // عرض السعر في السلة/الدفع: لو الكوبون مش صالح بنرجع السعر من غيره + السبب (عشان باقي الصفحة تفضل شغالة)
  async quote(slug: string, input: QuoteInput) {
    const tenant = await this.liveTenant(slug);
    const now = new Date();
    try {
      const { quote, ship } = await this.runQuote(tenant.id, input, now, true);
      return { ...this.quoteView(quote, slug, ship), couponError: null as string | null };
    } catch (e) {
      if (e instanceof AppError && e.code?.startsWith("COUPON_") && input.couponCode) {
        const { quote, ship } = await this.runQuote(tenant.id, { ...input, couponCode: null }, now, true);
        return { ...this.quoteView(quote, slug, ship), couponError: e.message };
      }
      throw e;
    }
  }

  async placeOrder(slug: string, input: CheckoutInput, frontendBase: string) {
    const tenant = await this.liveTenant(slug);
    const settings = await this.repo.settings(tenant.id);
    const takingOrders = this.shipping ? this.shipping.methodsOf(settings).methods.some((m) => m.enabled) : settings.deliveryEnabled || settings.pickupEnabled;
    if (!takingOrders) throw new AppError(400, "NOT_TAKING_ORDERS", "This shop isn't taking orders right now.");
    // العنوان قبل الحساب (رسالة أوضح من "طريقة الشحن مش متاحة")
    if (!input.shippingOptionId && input.fulfillment === "DELIVERY" && !(input.address && input.address.trim().length >= 3))
      throw new AppError(400, "NEED_ADDRESS", "Please write your delivery address.");
    const now = new Date();
    const { quote, ctx, ship } = await this.runQuote(tenant.id, input, now);
    const chosen = ship.selected;
    const fulfillment = chosen?.fulfillment ?? input.fulfillment ?? "DELIVERY";
    if (fulfillment === "DELIVERY" && !(input.address && input.address.trim().length >= 3)) throw new AppError(400, "NEED_ADDRESS", "Please write your delivery address.");
    if (chosen?.type === "CARRIER" && !(input.city && input.city.trim())) throw new AppError(400, "NEED_CITY", "Please write your city.");

    // طريقة الدفع (لو التاجر عامل طرق دفع والطلب مش ببلاش)
    const methods = await getTenantPaymentMethods(tenant.id);
    let method: PaymentMethod | null = null;
    if (quote.total > 0 && methods.length > 0) {
      method = pickPaymentMethod(methods, input.paymentMethodId);
      if (!method) throw new AppError(400, "BAD_PAYMENT_METHOD", "Please choose one of the available payment methods.");
    }
    const money = ctx.money;
    const payAmount = payableAmount(quote.total, money.currency, money.rates);
    const lowAlerts: string[] = [];
    const byId = new Map(ctx.products.map((p) => [p.id, p]));
    const thresholds = new Map((await this.repo.productsByIds(tenant.id, [...byId.keys()])).map((p) => [p.id, p.lowStockAt ?? DEFAULT_LOW_STOCK]));

    // المخزون (للاختيار أو المنتج) + الكوبون + رقم الطلب في transaction واحدة؛ رقم مكرر (طلبين في نفس اللحظة) = نحاول تاني
    let order: OrderRow | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      lowAlerts.length = 0;
      try {
        order = await this.repo.transaction(async (tx) => {
          for (const [variationId, need] of quote.variationNeed) {
            const p = byId.get(need.productId)!;
            const r = await this.repo.takeVariationStock(tx, tenant.id, p.id, variationId, need.qty, p.backorders);
            if (r.count === 0) {
              const now2 = await this.repo.variationStockOf(tx, tenant.id, variationId);
              throw new AppError(409, "OUT_OF_STOCK", soldOutMessage(p.name, now2?.stock ?? 0));
            }
            const after = await this.repo.variationStockOf(tx, tenant.id, variationId);
            const thr = thresholds.get(p.id) ?? DEFAULT_LOW_STOCK;
            if (after?.stock != null && after.stock <= thr && after.stock + need.qty > thr) {
              const v = p.variations.find((x) => x.id === variationId);
              lowAlerts.push(`${p.name}${v ? ` (${Object.values(labelsOf(p.attrs, v.attrs)).join(" / ")})` : ""}: ${after.stock} left`);
            }
          }
          for (const [productId, qty] of quote.productNeed) {
            const r = await this.repo.takeStock(tx, tenant.id, productId, qty);
            if (r.count === 0) {
              const now2 = await this.repo.stockOf(tx, tenant.id, productId);
              throw new AppError(409, "OUT_OF_STOCK", soldOutMessage(now2?.name ?? "this item", now2?.stock ?? 0));
            }
            const after = await this.repo.stockOf(tx, tenant.id, productId);
            const thr = after?.lowStockAt ?? DEFAULT_LOW_STOCK;
            if (after?.stock != null && after.stock <= thr && after.stock + qty > thr) lowAlerts.push(`${after.name}: ${after.stock} left`);
          }
          const sold = new Map<string, number>();
          for (const l of quote.lines) sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.qty);
          for (const [productId, qty] of sold) await this.repo.addSold(tx, tenant.id, productId, qty);

          // الكوبون: بنحجز استخدام (بيقفل صفه لحد آخر الـ transaction) وبعدين نعد استخدامات العميل
          if (quote.coupon) {
            const claimed = await this.catalogRepo.claimCoupon(tx, tenant.id, quote.coupon.id);
            if (!claimed) throw new AppError(400, "COUPON_USED_UP", "This code has been used up.");
            const coupon = ctx.coupon!;
            if (coupon.maxPerCustomer != null) {
              const uses = await this.catalogRepo.customerUses(tenant.id, coupon.id, phoneKey(input.customerPhone), tx);
              if (uses >= coupon.maxPerCustomer) throw new AppError(400, "COUPON_CUSTOMER_LIMIT", "You have already used this code.");
            }
          }

          const number = await this.repo.nextOrderNumber(tx, tenant.id);
          const created = await this.repo.createOrder(tx, {
            tenantId: tenant.id,
            number,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail || null,
            fulfillment,
            address: fulfillment === "DELIVERY" ? input.address?.trim() || null : null,
            shippingMethodId: chosen?.methodId ?? null,
            shippingMethodLabel: chosen?.label ?? null,
            shippingCarrier: chosen?.carrier ?? null,
            shippingService: chosen?.service ?? null,
            shippingCountry: fulfillment === "DELIVERY" ? input.country ?? null : null,
            shippingCity: fulfillment === "DELIVERY" ? input.city?.trim() || null : null,
            shippingPostalCode: fulfillment === "DELIVERY" ? input.postalCode?.trim() || null : null,
            area: quote.area,
            items: quote.lines.map(({ categoryIds: _c, ...l }) => l) as unknown as Prisma.InputJsonValue,
            subtotal: quote.subtotal,
            discount: quote.discount,
            couponId: quote.coupon?.id ?? null,
            couponCode: quote.coupon?.code ?? null,
            deliveryFee: quote.deliveryFee,
            tax: quote.tax,
            taxIncluded: quote.taxIncluded,
            taxLabel: quote.taxLabel,
            total: quote.total,
            currency: money.currency,
            payableAmount: payAmount,
            status: "NEW",
            paymentStatus: quote.total <= 0 ? "NOT_REQUIRED" : "UNPAID",
            paymentMethodType: method?.type ?? null,
            paymentMethodLabel: method?.label ?? null,
            note: input.note?.trim() || null,
          });
          if (quote.coupon) await this.catalogRepo.recordCouponUse(tx, { tenantId: tenant.id, couponId: quote.coupon.id, orderId: created.id, phoneKey: phoneKey(input.customerPhone) });
          return created;
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
        throw e;
      }
    }
    if (!order) throw new AppError(503, "BUSY", "The shop is busy — please try again.");

    if (lowAlerts.length)
      await createNotification({ tenantId: tenant.id, type: "CATALOG_ORDER", title: "Running low on stock", body: lowAlerts.slice(0, 5).join(" · "), link: "/store?tab=products" }).catch(() => {});

    // لينك دفع / MyFatoorah / SkipCash: بنجهز اللينك بعد ما الطلب يتحفظ (برقم المرجع الصح)
    let paymentError: string | null = null;
    if (method && (method.type === "LINK" || method.type === "MYFATOORAH" || method.type === "SKIPCASH")) {
      const pay = await startTenantPayment(tenant.id, method, {
        amount: payAmount,
        currency: money.currency,
        customer: { name: input.customerName, phone: input.customerPhone, email: input.customerEmail ?? null },
        redirectionUrl: `${frontendBase}/shop/${slug}/order/${order.id}`,
        reference: shortReference(order.id),
      }).catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (pay.ok) {
        await this.repo.updateOrder(tenant.id, order.id, { myFatoorahInvoiceId: (pay as any).invoiceId ?? null, myFatoorahPaymentUrl: (pay as any).paymentUrl ?? null });
      } else paymentError = (pay as any).error ?? "Couldn't start the payment.";
    }

    // SkipCash / MyFatoorah: التاجر بيتبلّغ بعد ما الدفع يتأكد؛ أي طريقة تانية: دلوقتي
    if (!isAutoGateway(method?.type)) await this.notifyMerchant(tenant.id, order);
    const view = await this.customerOrder(slug, order.id);
    return { ...view, paymentError };
  }

  private async notifyMerchant(tenantId: string, order: OrderRow) {
    const money = await getTenantMoney(tenantId);
    const total = formatUsdAs(Number(order.total), money.currency, money.rates);
    const lines = (order.items as unknown as { name: string; qty: number; sku?: string | null; options: Record<string, string> }[])
      .map((l) => `${l.qty}× ${l.name}${Object.keys(l.options ?? {}).length ? ` (${Object.values(l.options).join(" / ")})` : ""}${l.sku ? ` [${l.sku}]` : ""}`)
      .join("\n");
    const how = order.fulfillment === "PICKUP" ? "Pickup" : `Delivery${order.area ? ` — ${order.area}` : ""}`;
    await createNotification({
      tenantId,
      type: "CATALOG_ORDER",
      title: `New shop order #${order.number}`,
      body: `${order.customerName} — ${how} — ${total}`,
      link: "/store",
    });
    const s = await this.repo.settings(tenantId);
    if (isValidEmail(s.merchantEmail)) {
      const extra = [
        Number(order.discount) > 0 ? `Discount${order.couponCode ? ` (${order.couponCode})` : ""}: -${formatUsdAs(Number(order.discount), money.currency, money.rates)}` : "",
        Number(order.tax) > 0 ? `${order.taxLabel || "VAT"}${order.taxIncluded ? " (included)" : ""}: ${formatUsdAs(Number(order.tax), money.currency, money.rates)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await sendEmail(
        s.merchantEmail,
        `New order #${order.number} — ${order.customerName} · ${total}`,
        `New order #${order.number} from ${order.customerName} (${order.customerPhone})\n${how}${order.address ? `\n${order.address}` : ""}\n\n${lines}\n${extra ? `\n${extra}` : ""}\nTotal: ${total}\nPayment: ${order.paymentMethodLabel ?? "—"}${order.note ? `\n\nNote: ${order.note}` : ""}`
      ).catch(() => {});
    }
  }

  // صفحة الطلب للعميل (الـ id عشوائي = محدش يخمّنه)
  async customerOrder(slug: string, id: string, paymentId?: string) {
    const tenant = await this.liveTenant(slug);
    let o = await this.repo.order(tenant.id, id);
    if (!o) throw new NotFoundError("Order not found");

    // رجع من MyFatoorah: نسأل MyFatoorah بنفسنا، والدفعة لازم تخص فاتورة الطلب ده بالظبط
    if (paymentId && o.paymentMethodType === "MYFATOORAH" && o.paymentStatus === "UNPAID" && o.status !== "CANCELLED") {
      const check = await checkTenantMyFatoorahPaymentStatus(tenant.id, paymentId).catch(() => ({ paid: false, raw: null }));
      if (check.paid && paymentInvoiceMatch(check.raw, o.myFatoorahInvoiceId) === "match") {
        const r = await this.repo.updateOrder(tenant.id, o.id, { paymentStatus: "PAID" });
        if (r.count) {
          o = (await this.repo.order(tenant.id, id))!;
          await this.notifyMerchant(tenant.id, o);
        }
      }
    }
    // SkipCash: بنسأل SkipCash برقم الدفعة اللي عملناها (متخزن عندنا) - مش محتاجين حاجة من الرابط
    if (o.paymentMethodType === "SKIPCASH" && o.paymentStatus === "UNPAID" && o.status !== "CANCELLED" && o.myFatoorahInvoiceId) {
      const check = await verifyTenantGatewayPayment(tenant.id, { paymentMethodType: "SKIPCASH", invoiceId: o.myFatoorahInvoiceId }).catch(() => ({ paid: false, paymentId: null }));
      if (check.paid) {
        const r = await this.repo.markPaidIfUnpaid(tenant.id, o.id);
        if (r.count) {
          o = (await this.repo.order(tenant.id, id))!;
          await this.notifyMerchant(tenant.id, o);
        }
      }
    }

    const s = await this.repo.settings(tenant.id);
    // الشحنة (رقم التتبع + الأحداث) بتظهر للعميل بعد ما التاجر يعملها فعلًا
    const shipmentRaw = this.shipping ? await this.shipping.shipmentView(tenant.id, o.id) : null;
    const shipment = shipmentRaw && shipmentRaw.status === "CREATED" ? shipmentRaw : null;
    let instructions: Record<string, unknown> | null = null;
    if (o.paymentMethodType) {
      const methods = await getTenantPaymentMethods(tenant.id);
      const m = methods.find((x) => x.type === o!.paymentMethodType && x.label === o!.paymentMethodLabel);
      instructions = {
        type: o.paymentMethodType,
        label: o.paymentMethodLabel,
        details: m?.details ?? null,
        amount: num(o.payableAmount),
        currency: o.currency,
        reference: shortReference(o.id),
        paysOnDelivery: confirmsOnOrder(o.paymentMethodType),
        paymentUrl: o.paymentStatus === "UNPAID" && o.status !== "CANCELLED" ? o.myFatoorahPaymentUrl : null,
      };
    }
    const items = o.items as unknown as { productId: string; variationId?: string | null; name: string; sku?: string | null; options: Record<string, string>; price: number; regularPrice?: number; qty: number; photoId: string | null; purchaseNote?: string | null }[];
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt,
      customerName: o.customerName,
      fulfillment: o.fulfillment,
      area: o.area,
      address: o.address,
      note: o.note,
      trackingUrl: o.trackingUrl,
      shippingMethodLabel: o.shippingMethodLabel,
      shipment: shipment
        ? { carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber, trackingUrl: shipment.trackingUrl, status: shipment.trackingStatus, events: shipment.events.slice(0, 20).map((e) => ({ at: e.at, description: e.description, location: e.location ?? null })), deliveredAt: shipment.deliveredAt }
        : null,
      items: items.map(({ purchaseNote: _p, ...l }) => ({ ...l, photoUrl: l.photoId ? photoUrl(slug, l.photoId) : null })),
      // ملاحظات بعد الشراء (زي WooCommerce "purchase note") - بتظهر للعميل بعد الطلب بس
      purchaseNotes: [...new Map(items.filter((l) => l.purchaseNote).map((l) => [l.productId, { name: l.name, note: l.purchaseNote! }])).values()],
      subtotal: Number(o.subtotal),
      discount: Number(o.discount),
      couponCode: o.couponCode,
      deliveryFee: Number(o.deliveryFee),
      tax: Number(o.tax),
      taxIncluded: o.taxIncluded,
      taxLabel: o.taxLabel,
      total: Number(o.total),
      currency: o.currency,
      payableAmount: num(o.payableAmount),
      reference: shortReference(o.id),
      payment: instructions,
      shop: { brandName: s.brandName || tenant.name, whatsapp: s.whatsapp, phone: s.phone, pickupAddress: s.pickupAddress, accentColor: s.accentColor },
    };
  }
}
