import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { AppError, NotFoundError } from "../../core/errors";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { formatUsdAs, getRates, getTenantMoney, isCurrencyCode, payableAmount, rateFor } from "../../utils/money";
import { isModuleLive } from "../../utils/platform-config";
import { todayKeyInTimezone } from "../../utils/calendarDate";
import { zonedDateHourToUtc } from "../../utils/timezone";
import { checkTenantMyFatoorahPaymentStatus, getTenantPaymentMethods, paymentInvoiceMatch, startTenantPayment } from "../checkout/myfatoorah";
import { confirmsOnOrder, pickPaymentMethod, publicPaymentMethods, shortReference, type PaymentMethod } from "../payment-settings/payment-methods";
import {
  MAX_PHOTOS,
  MAX_PRODUCTS,
  canChangeStatus,
  decodeDataUrl,
  priceCart,
  readAreas,
  readOptions,
  soldOutMessage,
  stockToReturn,
  type CheckoutInput,
  type DeliveryConfig,
  type OrderStatus,
  type ProductForPricing,
} from "./store.logic";
import { StoreRepository } from "./store.repository";
import type { z } from "zod";
import type { productInput, productPatch, settingsInput } from "./store.logic";

const num = (v: Prisma.Decimal | number | string | null | undefined) => (v == null ? null : Number(v));
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// روابط الصور العامة (نسبية - الفرونت بيحط قبلها عنوان الـ API)
export const photoUrl = (slug: string, id: string) => `/api/public/store/${slug}/photo/${id}`;
const assetUrl = (slug: string, kind: "logo" | "cover", dataUrl: string | null) => (dataUrl ? `/api/public/store/${slug}/${kind}?v=${hash(dataUrl)}` : null);

type SettingsRow = Awaited<ReturnType<StoreRepository["settings"]>>;
type ProductRow = NonNullable<Awaited<ReturnType<StoreRepository["product"]>>>;
type OrderRow = NonNullable<Awaited<ReturnType<StoreRepository["order"]>>>;

function deliveryConfig(s: SettingsRow): DeliveryConfig {
  return {
    deliveryEnabled: s.deliveryEnabled,
    deliveryFee: Number(s.deliveryFee),
    freeDeliveryOver: num(s.freeDeliveryOver),
    areas: readAreas(s.deliveryAreas),
    pickupEnabled: s.pickupEnabled,
  };
}

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
  constructor(private readonly repo: StoreRepository) {}

  // ====================== التاجر ======================
  async getSettings(tenantId: string) {
    const [s, tenant] = await Promise.all([this.repo.settings(tenantId), this.repo.tenant(tenantId)]);
    return this.settingsView(s, tenant?.slug ?? "", tenant?.name ?? "");
  }

  private settingsView(s: SettingsRow, slug: string, tenantName: string) {
    const { logoDataUrl, coverDataUrl, deliveryAreas, deliveryFee, freeDeliveryOver, ...rest } = s;
    return {
      ...rest,
      slug,
      tenantName,
      deliveryFee: Number(deliveryFee),
      freeDeliveryOver: num(freeDeliveryOver),
      deliveryAreas: readAreas(deliveryAreas),
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

  // ---------- الأقسام ----------
  categories(tenantId: string) {
    return this.repo.categories(tenantId);
  }
  async createCategory(tenantId: string, name: string) {
    if ((await this.repo.categories(tenantId)).length >= 100) throw new AppError(400, "TOO_MANY", "Up to 100 categories.");
    return this.repo.createCategory(tenantId, name);
  }
  async renameCategory(tenantId: string, id: string, name: string) {
    const r = await this.repo.renameCategory(tenantId, id, name);
    if (r.count === 0) throw new NotFoundError("Category not found");
    return this.repo.category(tenantId, id);
  }
  async deleteCategory(tenantId: string, id: string) {
    if (!(await this.repo.category(tenantId, id))) throw new NotFoundError("Category not found");
    await this.repo.deleteCategory(tenantId, id);
  }
  async orderCategories(tenantId: string, ids: string[]) {
    await this.repo.orderCategories(tenantId, ids);
    return this.repo.categories(tenantId);
  }

  // ---------- المنتجات ----------
  private productView(p: ProductRow, slug: string) {
    return {
      id: p.id,
      categoryId: p.categoryId,
      name: p.name,
      description: p.description,
      price: Number(p.price),
      comparePrice: num(p.comparePrice),
      sku: p.sku,
      stock: p.stock,
      options: readOptions(p.options),
      active: p.active,
      featured: p.featured,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt,
      photos: p.photos.map((ph) => ({ id: ph.id, url: photoUrl(slug, ph.id) })),
    };
  }

  private async slug(tenantId: string) {
    return (await this.repo.tenant(tenantId))?.slug ?? "";
  }

  async products(tenantId: string) {
    const [list, slug] = await Promise.all([this.repo.products(tenantId), this.slug(tenantId)]);
    return list.map((p) => this.productView(p, slug));
  }

  async product(tenantId: string, id: string) {
    const p = await this.repo.product(tenantId, id);
    if (!p) throw new NotFoundError("Product not found");
    return this.productView(p, await this.slug(tenantId));
  }

  private async checkCategory(tenantId: string, categoryId: string | null | undefined) {
    if (categoryId && !(await this.repo.category(tenantId, categoryId))) throw new AppError(400, "BAD_CATEGORY", "That category doesn't exist.");
  }

  async createProduct(tenantId: string, input: z.infer<typeof productInput>) {
    if ((await this.repo.countProducts(tenantId)) >= MAX_PRODUCTS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_PRODUCTS} products per shop.`);
    await this.checkCategory(tenantId, input.categoryId);
    const created = await this.repo.createProduct(tenantId, {
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      price: input.price,
      comparePrice: input.comparePrice ?? null,
      sku: input.sku ?? null,
      stock: input.stock ?? null,
      options: input.options?.length ? (input.options as Prisma.InputJsonValue) : Prisma.DbNull,
      active: input.active ?? true,
      featured: input.featured ?? false,
    });
    return this.product(tenantId, created.id);
  }

  async updateProduct(tenantId: string, id: string, input: z.infer<typeof productPatch>) {
    const current = await this.repo.product(tenantId, id);
    if (!current) throw new NotFoundError("Product not found");
    await this.checkCategory(tenantId, input.categoryId);
    // السعر القديم لازم يفضل أعلى من السعر بعد التعديل
    const price = input.price ?? Number(current.price);
    const compare = input.comparePrice !== undefined ? input.comparePrice : num(current.comparePrice);
    if (compare != null && !(compare > price)) throw new AppError(400, "BAD_COMPARE_PRICE", "The old price must be higher than the price (or leave it empty)");
    const { options, ...rest } = input;
    const data: Prisma.StoreProductUncheckedUpdateManyInput = { ...rest };
    if (options !== undefined) data.options = options.length ? (options as Prisma.InputJsonValue) : Prisma.DbNull;
    await this.repo.updateProduct(tenantId, id, data);
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
    const copy = await this.repo.createProduct(tenantId, {
      name: `${p.name} (copy)`.slice(0, 120),
      description: p.description,
      categoryId: p.categoryId,
      price: p.price,
      comparePrice: p.comparePrice,
      sku: null,
      stock: p.stock,
      options: p.options ?? Prisma.DbNull,
      // النسخة بتبدأ مخفية لحد ما التاجر يعدّلها
      active: false,
      featured: false,
    });
    const photos = await this.repo.photosWithData(tenantId, id);
    if (photos.length) await this.repo.copyPhotos(tenantId, copy.id, photos);
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
    return this.product(tenantId, productId);
  }
  async orderPhotos(tenantId: string, productId: string, ids: string[]) {
    if (!(await this.repo.product(tenantId, productId))) throw new NotFoundError("Product not found");
    await this.repo.orderPhotos(tenantId, productId, ids);
    return this.product(tenantId, productId);
  }

  // ---------- الطلبات ----------
  async orders(tenantId: string, status?: string) {
    const tz = await this.repo.timezone(tenantId);
    const todayKey = todayKeyInTimezone(tz);
    const todayStart = zonedDateHourToUtc(todayKey, 0, tz);
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600_000);
    const [orders, stats, slug] = await Promise.all([this.repo.orders(tenantId, status), this.repo.orderStats(tenantId, todayStart, weekStart), this.slug(tenantId)]);
    return { orders: orders.map((o) => this.orderView(o, slug)), stats };
  }

  private orderView(o: OrderRow, slug: string) {
    const items = (Array.isArray(o.items) ? o.items : []) as unknown as { photoId?: string | null }[];
    return {
      ...o,
      items: items.map((l) => ({ ...l, photoUrl: l.photoId ? photoUrl(slug, l.photoId) : null })),
      subtotal: Number(o.subtotal),
      deliveryFee: Number(o.deliveryFee),
      total: Number(o.total),
      payableAmount: num(o.payableAmount),
      reference: shortReference(o.id),
    };
  }

  async order(tenantId: string, id: string) {
    const o = await this.repo.order(tenantId, id);
    if (!o) throw new NotFoundError("Order not found");
    return this.orderView(o, await this.slug(tenantId));
  }

  async updateOrder(tenantId: string, id: string, input: { status?: OrderStatus; trackingUrl?: string | null; note?: string | null }) {
    const o = await this.repo.order(tenantId, id);
    if (!o) throw new NotFoundError("Order not found");
    if (input.status && !canChangeStatus(o.status, input.status)) throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled and can't be changed.");
    const { status, ...rest } = input;
    if (status === "CANCELLED" && o.status !== "CANCELLED") {
      // الإلغاء بيرجّع المخزون مرة واحدة بس (حتى لو اتداس مرتين في نفس اللحظة)
      await this.repo.transaction(async (tx) => {
        const claimed = await this.repo.claimOrder(tx, tenantId, id, { status: { not: "CANCELLED" } }, { status: "CANCELLED", ...rest });
        if (claimed.count === 0) return;
        for (const [productId, qty] of stockToReturn(o.items)) await this.repo.returnStock(tx, tenantId, productId, qty);
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

  async shop(slug: string) {
    const tenant = await this.liveTenant(slug);
    const [s, categories, products, methods, rates] = await Promise.all([
      this.repo.settings(tenant.id),
      this.repo.categories(tenant.id),
      this.repo.products(tenant.id, true),
      getTenantPaymentMethods(tenant.id),
      getRates(),
    ]);
    const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
    return {
      slug,
      brandName: s.brandName || tenant.name,
      tagline: s.tagline,
      about: s.about,
      accentColor: s.accentColor,
      logoUrl: assetUrl(slug, "logo", s.logoDataUrl),
      coverUrl: assetUrl(slug, "cover", s.coverDataUrl),
      contact: { whatsapp: s.whatsapp, phone: s.phone, email: s.email, instagram: s.instagram, address: s.address },
      delivery: {
        enabled: s.deliveryEnabled,
        fee: Number(s.deliveryFee),
        freeOver: num(s.freeDeliveryOver),
        areas: readAreas(s.deliveryAreas),
      },
      pickup: { enabled: s.pickupEnabled, address: s.pickupAddress },
      currency,
      rate: rateFor(currency, rates),
      paymentMethods: publicPaymentMethods(methods),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      productCount: products.length,
      products: products.map((p) => ({
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        price: Number(p.price),
        comparePrice: num(p.comparePrice),
        featured: p.featured,
        soldOut: p.stock === 0,
        lowStock: p.stock != null && p.stock > 0 && p.stock <= 5 ? p.stock : null,
        hasOptions: readOptions(p.options).length > 0,
        photoUrl: p.photos[0] ? photoUrl(slug, p.photos[0].id) : null,
        photoUrl2: p.photos[1] ? photoUrl(slug, p.photos[1].id) : null,
      })),
    };
  }

  async shopProduct(slug: string, id: string) {
    const tenant = await this.liveTenant(slug);
    const p = await this.repo.product(tenant.id, id);
    if (!p || !p.active) throw new NotFoundError("Product not found");
    return {
      id: p.id,
      categoryId: p.categoryId,
      name: p.name,
      description: p.description,
      price: Number(p.price),
      comparePrice: num(p.comparePrice),
      sku: p.sku,
      soldOut: p.stock === 0,
      stockLeft: p.stock,
      options: readOptions(p.options),
      photos: p.photos.map((ph) => photoUrl(slug, ph.id)),
    };
  }

  // الصور: من غير شرط الاشتراك (رابط بـ id عشوائي) عشان التاجر في التجربة يشوف صوره في اللوحة
  async image(slug: string, kind: "photo" | "logo" | "cover", photoId?: string) {
    const tenant = await this.repo.tenantBySlug(slug);
    if (!tenant) throw new NotFoundError("Not found");
    let dataUrl: string | null = null;
    let tag = "";
    if (kind === "photo") {
      const ph = await this.repo.photoBytes(tenant.id, photoId ?? "");
      dataUrl = ph?.dataUrl ?? null;
      tag = ph ? `${ph.id}-${ph.createdAt.getTime()}` : "";
    } else {
      const s = await this.repo.settings(tenant.id);
      dataUrl = kind === "logo" ? s.logoDataUrl : s.coverDataUrl;
      tag = dataUrl ? hash(dataUrl) : "";
    }
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) throw new NotFoundError("Not found");
    return { ...decoded, etag: `"${hash(tag)}"` };
  }

  async placeOrder(slug: string, input: CheckoutInput, frontendBase: string) {
    const tenant = await this.liveTenant(slug);
    const settings = await this.repo.settings(tenant.id);
    const cfg = deliveryConfig(settings);
    if (!cfg.deliveryEnabled && !cfg.pickupEnabled) throw new AppError(400, "NOT_TAKING_ORDERS", "This shop isn't taking orders right now.");
    if (input.fulfillment === "DELIVERY" && !(input.address && input.address.trim().length >= 3)) throw new AppError(400, "NEED_ADDRESS", "Please write your delivery address.");

    const ids = [...new Set(input.items.map((i) => i.productId))];
    const rows = await this.repo.productsByIds(tenant.id, ids);
    const products: ProductForPricing[] = rows.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      stock: p.stock,
      active: p.active,
      options: readOptions(p.options),
      coverPhotoId: p.photos[0]?.id ?? null,
    }));
    const cart = priceCart(input.items, products, cfg, input.fulfillment, input.area);

    // طريقة الدفع (لو التاجر عامل طرق دفع والطلب مش ببلاش)
    const methods = await getTenantPaymentMethods(tenant.id);
    let method: PaymentMethod | null = null;
    if (cart.total > 0 && methods.length > 0) {
      method = pickPaymentMethod(methods, input.paymentMethodId);
      if (!method) throw new AppError(400, "BAD_PAYMENT_METHOD", "Please choose one of the available payment methods.");
    }
    const money = await getTenantMoney(tenant.id);
    const payAmount = payableAmount(cart.total, money.currency, money.rates);

    // المخزون + رقم الطلب في transaction واحدة؛ رقم مكرر (طلبين في نفس اللحظة) = نحاول تاني
    let order: OrderRow | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      try {
        order = await this.repo.transaction(async (tx) => {
          for (const [productId, qty] of cart.need) {
            const r = await this.repo.takeStock(tx, tenant.id, productId, qty);
            if (r.count === 0) {
              const now = await this.repo.stockOf(tx, tenant.id, productId);
              throw new AppError(409, "OUT_OF_STOCK", soldOutMessage(now?.name ?? "this item", now?.stock ?? 0));
            }
          }
          const number = await this.repo.nextOrderNumber(tx, tenant.id);
          return this.repo.createOrder(tx, {
            tenantId: tenant.id,
            number,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail || null,
            fulfillment: input.fulfillment,
            address: input.fulfillment === "DELIVERY" ? input.address?.trim() || null : null,
            area: cart.area,
            items: cart.lines as unknown as Prisma.InputJsonValue,
            subtotal: cart.subtotal,
            deliveryFee: cart.deliveryFee,
            total: cart.total,
            currency: money.currency,
            payableAmount: payAmount,
            status: "NEW",
            paymentStatus: cart.total <= 0 ? "NOT_REQUIRED" : "UNPAID",
            paymentMethodType: method?.type ?? null,
            paymentMethodLabel: method?.label ?? null,
            note: input.note?.trim() || null,
          });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
        throw e;
      }
    }
    if (!order) throw new AppError(503, "BUSY", "The shop is busy — please try again.");

    // لينك دفع / MyFatoorah: بنجهز اللينك بعد ما الطلب يتحفظ (برقم المرجع الصح)
    let paymentError: string | null = null;
    if (method && (method.type === "LINK" || method.type === "MYFATOORAH")) {
      const pay = await startTenantPayment(tenant.id, method, {
        amount: payAmount,
        redirectionUrl: `${frontendBase}/shop/${slug}/order/${order.id}`,
        reference: shortReference(order.id),
      }).catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (pay.ok) {
        await this.repo.updateOrder(tenant.id, order.id, { myFatoorahInvoiceId: (pay as any).invoiceId ?? null, myFatoorahPaymentUrl: (pay as any).paymentUrl ?? null });
      } else paymentError = (pay as any).error ?? "Couldn't start the payment.";
    }

    // MyFatoorah: التاجر بيتبلّغ بعد ما الدفع يتأكد؛ أي طريقة تانية: دلوقتي
    if (method?.type !== "MYFATOORAH") await this.notifyMerchant(tenant.id, order);
    const view = await this.customerOrder(slug, order.id);
    return { ...view, paymentError };
  }

  private async notifyMerchant(tenantId: string, order: OrderRow) {
    const money = await getTenantMoney(tenantId);
    const total = formatUsdAs(Number(order.total), money.currency, money.rates);
    const lines = (order.items as unknown as { name: string; qty: number; options: Record<string, string> }[])
      .map((l) => `${l.qty}× ${l.name}${Object.keys(l.options ?? {}).length ? ` (${Object.values(l.options).join(" / ")})` : ""}`)
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
      await sendEmail(
        s.merchantEmail,
        `New order #${order.number} — ${order.customerName} · ${total}`,
        `New order #${order.number} from ${order.customerName} (${order.customerPhone})\n${how}${order.address ? `\n${order.address}` : ""}\n\n${lines}\n\nTotal: ${total}\nPayment: ${order.paymentMethodLabel ?? "—"}${order.note ? `\n\nNote: ${order.note}` : ""}`
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

    const s = await this.repo.settings(tenant.id);
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
      items: (o.items as unknown as { productId: string; name: string; options: Record<string, string>; price: number; qty: number; photoId: string | null }[]).map((l) => ({
        ...l,
        photoUrl: l.photoId ? photoUrl(slug, l.photoId) : null,
      })),
      subtotal: Number(o.subtotal),
      deliveryFee: Number(o.deliveryFee),
      total: Number(o.total),
      currency: o.currency,
      payableAmount: num(o.payableAmount),
      reference: shortReference(o.id),
      payment: instructions,
      shop: { brandName: s.brandName || tenant.name, whatsapp: s.whatsapp, phone: s.phone, pickupAddress: s.pickupAddress, accentColor: s.accentColor },
    };
  }
}
