import { AppError } from "../../core/errors";
import {
  effectivePrice,
  isSoldOut,
  labelsOf,
  round6,
  stockSource,
  variationSale,
  type ResolvedAttr,
  type SaleFields,
  type VariationRow,
} from "./store-catalog.logic";

// حساب السلة كله على السيرفر (زي WooCommerce): السعر الحالي (تخفيض بمواعيده)، الاختيار ومخزونه، الكوبون،
// التوصيل حسب المنطقة، والضريبة. أي سعر جاي من العميل بيتجاهل خالص. كل المبالغ USD.

export const MAX_LINES = 50;
export const MAX_QTY = 99;

// ---------- التوصيل ----------
export interface DeliveryArea {
  name: string;
  fee: number;
  // مجاني فوق مبلغ معيّن في المنطقة دي بس (null = نفس القاعدة العامة)
  freeOver?: number | null;
}
export interface DeliveryConfig {
  deliveryEnabled: boolean;
  deliveryFee: number;
  freeDeliveryOver: number | null;
  areas: DeliveryArea[];
  pickupEnabled: boolean;
}

// سعر التوصيل: حسب المنطقة لو التاجر عامل مناطق، غير كده السعر الثابت، ومجاني فوق مبلغ معيّن (أو بالكوبون)
export function deliveryFeeFor(
  cfg: DeliveryConfig,
  fulfillment: "DELIVERY" | "PICKUP",
  area: string | null | undefined,
  goods: number,
  freeShipping = false
): { fee: number; area: string | null; free: "coupon" | "threshold" | null } {
  if (fulfillment === "PICKUP") {
    if (!cfg.pickupEnabled) throw new AppError(400, "NO_PICKUP", "This shop doesn't offer pickup. Please choose delivery.");
    return { fee: 0, area: null, free: null };
  }
  if (!cfg.deliveryEnabled) throw new AppError(400, "NO_DELIVERY", "This shop doesn't deliver. Please choose pickup.");
  let fee = cfg.deliveryFee;
  let freeOver = cfg.freeDeliveryOver;
  let areaName: string | null = null;
  if (cfg.areas.length > 0) {
    const found = cfg.areas.find((a) => a.name.toLowerCase() === (area ?? "").trim().toLowerCase());
    if (!found) throw new AppError(400, "BAD_AREA", "Please choose your delivery area.");
    fee = found.fee;
    if (found.freeOver !== undefined && found.freeOver !== null) freeOver = found.freeOver;
    areaName = found.name;
  } else if (area && area.trim()) {
    areaName = area.trim().slice(0, 60);
  }
  if (freeShipping && fee > 0) return { fee: 0, area: areaName, free: "coupon" };
  if (freeOver != null && goods >= freeOver && fee > 0) return { fee: 0, area: areaName, free: "threshold" };
  return { fee: round6(fee), area: areaName, free: null };
}

// ---------- الضريبة ----------
export interface TaxConfig {
  enabled: boolean;
  rate: number; // %
  inclusive: boolean; // الأسعار شاملة الضريبة
  onShipping: boolean;
  label: string | null;
}

export function taxFor(cfg: TaxConfig, goods: number, shipping: number): { amount: number; included: boolean } {
  if (!cfg.enabled || !(cfg.rate > 0)) return { amount: 0, included: false };
  const base = Math.max(0, goods) + (cfg.onShipping ? shipping : 0);
  if (cfg.inclusive) return { amount: round6((base * cfg.rate) / (100 + cfg.rate)), included: true };
  return { amount: round6((base * cfg.rate) / 100), included: false };
}

// ---------- المنتجات للحساب ----------
export interface ProductForPricing extends SaleFields {
  id: string;
  name: string;
  type: string;
  sku: string | null;
  stock: number | null;
  backorders: boolean;
  active: boolean;
  categoryIds: string[];
  coverPhotoId: string | null;
  purchaseNote: string | null;
  attrs: ResolvedAttr[];
  variations: VariationRow[];
}

export interface CartLineInput {
  productId: string;
  variationId?: string | null;
  qty: number;
  // قديم (سلة متخزنة قبل التحديث): {Size: "M"} بالأسامي
  options?: Record<string, unknown> | null;
}

export interface PricedLine {
  productId: string;
  variationId: string | null;
  name: string;
  sku: string | null;
  // {Color: "Red", Size: "M"} للعرض (اسمه options عشان الطلبات القديمة)
  options: Record<string, string>;
  price: number;
  regularPrice: number;
  qty: number;
  photoId: string | null;
  categoryIds: string[];
  // المخزون بيتخصم منين (عشان الإلغاء يرجّعه لنفس المكان)
  stockFrom: "variation" | "product" | null;
  purchaseNote: string | null;
}

export function soldOutMessage(name: string, left: number) {
  return left <= 0 ? `Sorry, ${name} is sold out.` : `Only ${left} left of ${name}. Please lower the quantity.`;
}

// الاختيار: بالـ id، أو (سلة قديمة) بأسامي القيم
function findVariation(p: ProductForPricing, line: CartLineInput): VariationRow {
  const enabled = p.variations.filter((v) => v.enabled);
  if (line.variationId) {
    const v = enabled.find((x) => x.id === line.variationId);
    if (!v) throw new AppError(400, "BAD_VARIATION", `That choice of ${p.name} isn't available any more. Please choose again.`);
    return v;
  }
  const given = line.options ?? {};
  const wanted = Object.entries(given).filter(([, v]) => typeof v === "string") as [string, string][];
  const vars = p.attrs.filter((a) => a.forVariations);
  for (const a of vars) if (!wanted.some(([k]) => k === a.name)) throw new AppError(400, "BAD_OPTIONS", `Please choose ${a.name} for ${p.name}.`);
  const v = enabled.find((x) => {
    const labels = labelsOf(p.attrs, x.attrs);
    return vars.every((a) => labels[a.name] === given[a.name]);
  });
  if (!v) throw new AppError(400, "BAD_OPTIONS", `That choice of ${p.name} isn't available. Please choose again.`);
  return v;
}

export interface PricedCart {
  lines: PricedLine[];
  productNeed: Map<string, number>; // مخزون مشترك للمنتج
  variationNeed: Map<string, { productId: string; qty: number }>;
  subtotal: number;
}

export function priceLines(lines: CartLineInput[], products: ProductForPricing[], now: Date): PricedCart {
  if (lines.length === 0) throw new AppError(400, "EMPTY_CART", "Your cart is empty.");
  if (lines.length > MAX_LINES) throw new AppError(400, "TOO_MANY_LINES", `Up to ${MAX_LINES} different items per order.`);
  const byId = new Map(products.map((p) => [p.id, p]));
  const priced: PricedLine[] = [];
  const productNeed = new Map<string, number>();
  const variationNeed = new Map<string, { productId: string; qty: number }>();
  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p || !p.active) throw new AppError(400, "UNAVAILABLE", "One of the items in your cart is no longer available. Please remove it and try again.");
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw new AppError(400, "BAD_QTY", `Quantity must be between 1 and ${MAX_QTY}.`);
    let v: VariationRow | null = null;
    if (p.type === "variable") v = findVariation(p, line);
    const sale = v ? variationSale(p, v) : p;
    const e = effectivePrice(sale, now);
    const src = stockSource(p, v);
    const existing = priced.find((x) => x.productId === p.id && x.variationId === (v?.id ?? null));
    if (existing) {
      existing.qty += line.qty;
      // نفس المنتج مكرر في السلة: المجموع برضه لازم يفضل في الحد
      if (existing.qty > MAX_QTY) throw new AppError(400, "BAD_QTY", `Quantity must be between 1 and ${MAX_QTY}.`);
    } else
      priced.push({
        productId: p.id,
        variationId: v?.id ?? null,
        name: p.name,
        sku: v?.sku || p.sku,
        options: v ? labelsOf(p.attrs, v.attrs) : {},
        price: e.price,
        regularPrice: e.regular,
        qty: line.qty,
        photoId: v?.photoId ?? p.coverPhotoId,
        categoryIds: p.categoryIds,
        stockFrom: src.from,
        purchaseNote: p.purchaseNote,
      });
    if (src.from === "variation") {
      const cur = variationNeed.get(v!.id);
      variationNeed.set(v!.id, { productId: p.id, qty: (cur?.qty ?? 0) + line.qty });
    } else if (src.from === "product") productNeed.set(p.id, (productNeed.get(p.id) ?? 0) + line.qty);
  }
  // المخزون (قبل ما نحجز): رسالة واضحة للعميل
  for (const l of priced) {
    const p = byId.get(l.productId)!;
    if (p.backorders) continue;
    const v = l.variationId ? p.variations.find((x) => x.id === l.variationId)! : null;
    const src = stockSource(p, v);
    if (src.left == null) continue;
    const need = src.from === "variation" ? variationNeed.get(v!.id)!.qty : productNeed.get(p.id) ?? 0;
    const label = Object.keys(l.options).length ? `${p.name} (${Object.values(l.options).join(" / ")})` : p.name;
    if (isSoldOut(p, v) || src.left < need) throw new AppError(409, "OUT_OF_STOCK", soldOutMessage(src.from === "product" && v ? p.name : label, src.left));
  }
  const subtotal = round6(priced.reduce((s, l) => s + l.price * l.qty, 0));
  return { lines: priced, productNeed, variationNeed, subtotal };
}

// ---------- الكوبونات ----------
export const COUPON_KINDS = ["PERCENT", "FIXED_CART", "FIXED_PRODUCT"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export interface CouponRule {
  id: string;
  code: string;
  kind: CouponKind;
  amount: number;
  minSpend: number | null;
  maxUses: number | null;
  usedCount: number;
  maxPerCustomer: number | null;
  expiresAt: Date | null;
  productIds: string[];
  // الأقسام + كل اللي تحتها
  categoryIds: Set<string>;
  freeShipping: boolean;
  active: boolean;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

// آخر 8 أرقام من التليفون (نفس فكرة phoneMatch)
export const phoneKey = (phone: string) => phone.replace(/\D/g, "").slice(-8);

export function couponLineEligible(c: CouponRule, l: Pick<PricedLine, "productId" | "categoryIds">): boolean {
  const anyRule = c.productIds.length > 0 || c.categoryIds.size > 0;
  if (!anyRule) return true;
  return c.productIds.includes(l.productId) || l.categoryIds.some((id) => c.categoryIds.has(id));
}

export function applyCoupon(
  c: CouponRule,
  lines: PricedLine[],
  subtotal: number,
  now: Date,
  customerUses: number,
  fmt: (usd: number) => string
): { discount: number; freeShipping: boolean } {
  if (!c.active) throw new AppError(400, "COUPON_INVALID", "This code isn't valid.");
  if (c.expiresAt && now >= c.expiresAt) throw new AppError(400, "COUPON_EXPIRED", "This code has expired.");
  if (c.maxUses != null && c.usedCount >= c.maxUses) throw new AppError(400, "COUPON_USED_UP", "This code has been used up.");
  if (c.maxPerCustomer != null && customerUses >= c.maxPerCustomer) throw new AppError(400, "COUPON_CUSTOMER_LIMIT", "You have already used this code.");
  if (c.minSpend != null && subtotal < c.minSpend) throw new AppError(400, "COUPON_MIN_SPEND", `Spend at least ${fmt(c.minSpend)} to use this code.`);
  const eligible = lines.filter((l) => couponLineEligible(c, l));
  if (eligible.length === 0) throw new AppError(400, "COUPON_NOT_APPLICABLE", "This code doesn't apply to the items in your cart.");
  const eligibleTotal = eligible.reduce((s, l) => s + l.price * l.qty, 0);
  let discount = 0;
  if (c.kind === "PERCENT") discount = (eligibleTotal * Math.min(100, c.amount)) / 100;
  else if (c.kind === "FIXED_CART") discount = Math.min(c.amount, eligibleTotal);
  else for (const l of eligible) discount += Math.min(c.amount, l.price) * l.qty;
  return { discount: round6(Math.min(discount, subtotal)), freeShipping: c.freeShipping };
}

// ---------- الحساب النهائي ----------
export interface Quote {
  lines: PricedLine[];
  productNeed: Map<string, number>;
  variationNeed: Map<string, { productId: string; qty: number }>;
  subtotal: number;
  discount: number;
  coupon: { id: string; code: string; freeShipping: boolean } | null;
  deliveryFee: number;
  freeDelivery: "coupon" | "threshold" | null;
  area: string | null;
  tax: number;
  taxIncluded: boolean;
  taxLabel: string | null;
  taxRate: number;
  total: number;
}

export function quoteCart(args: {
  lines: CartLineInput[];
  products: ProductForPricing[];
  delivery: DeliveryConfig;
  tax: TaxConfig;
  fulfillment: "DELIVERY" | "PICKUP";
  area?: string | null;
  coupon?: CouponRule | null;
  customerUses?: number;
  now: Date;
  fmt: (usd: number) => string;
  // طرق الشحن الجديدة (modules/store/shipping): بتحسب سعر الشحن بعد الخصم. من غيرها = التوصيل القديم
  shipping?: (goods: number, freeShipping: boolean) => { fee: number; area: string | null; free: "coupon" | "threshold" | null };
}): Quote {
  const cart = priceLines(args.lines, args.products, args.now);
  let discount = 0;
  let freeShipping = false;
  if (args.coupon) {
    const r = applyCoupon(args.coupon, cart.lines, cart.subtotal, args.now, args.customerUses ?? 0, args.fmt);
    discount = r.discount;
    freeShipping = r.freeShipping;
  }
  const goods = round6(cart.subtotal - discount);
  const d = args.shipping ? args.shipping(goods, freeShipping) : deliveryFeeFor(args.delivery, args.fulfillment, args.area, goods, freeShipping);
  const t = taxFor(args.tax, goods, d.fee);
  const total = round6(goods + d.fee + (t.included ? 0 : t.amount));
  return {
    ...cart,
    discount,
    coupon: args.coupon ? { id: args.coupon.id, code: args.coupon.code, freeShipping } : null,
    deliveryFee: d.fee,
    freeDelivery: d.free,
    area: d.area,
    tax: t.amount,
    taxIncluded: t.included,
    taxLabel: args.tax.enabled && args.tax.rate > 0 ? args.tax.label || "VAT" : null,
    taxRate: args.tax.enabled ? args.tax.rate : 0,
    total,
  };
}

// الإلغاء بيرجّع المخزون لنفس المكان اللي اتخصم منه
export function stockToReturn(items: unknown): { products: Map<string, number>; variations: Map<string, number> } {
  const products = new Map<string, number>();
  const variations = new Map<string, number>();
  if (!Array.isArray(items)) return { products, variations };
  for (const it of items) {
    const qty = Number(it?.qty);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    const pid = typeof it?.productId === "string" ? it.productId : null;
    const vid = typeof it?.variationId === "string" ? it.variationId : null;
    // طلبات قديمة (من غير stockFrom) = مخزون المنتج
    const from = it?.stockFrom === undefined ? "product" : it.stockFrom;
    if (from === "variation" && vid) variations.set(vid, (variations.get(vid) ?? 0) + qty);
    else if (from === "product" && pid) products.set(pid, (products.get(pid) ?? 0) + qty);
  }
  return { products, variations };
}
