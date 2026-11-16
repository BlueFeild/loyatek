import { z } from "zod";
import { AppError } from "../../core/errors";
import { imageDataUrl } from "../booking/page-design";

// منطق المتجر "النقي" (من غير داتابيز): التحقق من البيانات، الاختيارات (مقاس/لون)،
// حساب السلة والتوصيل. كل الأسعار هنا بالدولار (زي ما هي متخزنة).

export const MAX_PRODUCTS = 1000;
export const MAX_PHOTOS = 12;
export const MAX_OPTIONS = 3;
export const MAX_OPTION_VALUES = 20;
export const MAX_AREAS = 50;
export const MAX_LINES = 50;
export const MAX_QTY = 99;
export const PHOTO_MAX_CHARS = 2_100_000; // ~1.5 MB
export const LOGO_MAX_CHARS = 700_000; // ~500 KB
export const COVER_MAX_CHARS = 2_500_000; // ~1.8 MB

export const ORDER_STATUSES = ["NEW", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #111827");
const money = z.number().finite().min(0, "Prices can't be negative").max(10_000_000);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));

// ---------- الاختيارات (مقاس / لون / حجم) ----------
export interface ProductOption {
  name: string;
  values: string[];
}

export const optionsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1, "Give each option a name (e.g. Size)").max(40),
      values: z.array(z.string().trim().min(1).max(40)).min(1, "Each option needs at least one choice").max(MAX_OPTION_VALUES, `Up to ${MAX_OPTION_VALUES} choices per option`),
    })
  )
  .max(MAX_OPTIONS, `Up to ${MAX_OPTIONS} options per product`)
  .superRefine((opts, ctx) => {
    const names = new Set<string>();
    opts.forEach((o, i) => {
      const key = o.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `The option "${o.name}" is there twice` });
      names.add(key);
    });
  })
  // نشيل الاختيارات المكررة جوه نفس الخيار
  .transform((opts) => opts.map((o) => ({ name: o.name, values: [...new Set(o.values)] })));

// اللي متخزن في الداتابيز ممكن يكون أي حاجة (Json) - بنقراه بأمان
export function readOptions(raw: unknown): ProductOption[] {
  const parsed = optionsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

// الاختيارات اللي العميل بعتها لازم تطابق خيارات المنتج بالظبط: كل خيار له قيمة من القايمة، ومفيش حاجة زيادة
export function matchOptions(productName: string, options: ProductOption[], chosen: Record<string, unknown> | null | undefined): Record<string, string> {
  const given = chosen ?? {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(given)) {
    if (!options.some((o) => o.name === key)) throw new AppError(400, "BAD_OPTIONS", `"${key}" isn't an option of ${productName}.`);
  }
  for (const o of options) {
    const v = given[o.name];
    if (typeof v !== "string" || !v) throw new AppError(400, "BAD_OPTIONS", `Please choose ${o.name} for ${productName}.`);
    if (!o.values.includes(v)) throw new AppError(400, "BAD_OPTIONS", `"${v}" isn't available for ${o.name} of ${productName}.`);
    out[o.name] = v;
  }
  return out;
}

// ---------- التوصيل ----------
export interface DeliveryArea {
  name: string;
  fee: number;
}

export const areasSchema = z
  .array(z.object({ name: z.string().trim().min(1, "Give each area a name").max(60), fee: money }))
  .max(MAX_AREAS, `Up to ${MAX_AREAS} delivery areas`)
  .superRefine((areas, ctx) => {
    const seen = new Set<string>();
    areas.forEach((a, i) => {
      const k = a.name.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `The area "${a.name}" is there twice` });
      seen.add(k);
    });
  });

export function readAreas(raw: unknown): DeliveryArea[] {
  const parsed = areasSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

export interface DeliveryConfig {
  deliveryEnabled: boolean;
  deliveryFee: number;
  freeDeliveryOver: number | null;
  areas: DeliveryArea[];
  pickupEnabled: boolean;
}

// سعر التوصيل: حسب المنطقة لو التاجر عامل مناطق، غير كده السعر الثابت، ومجاني فوق مبلغ معين
export function deliveryFeeFor(cfg: DeliveryConfig, fulfillment: "DELIVERY" | "PICKUP", area: string | null | undefined, subtotal: number): { fee: number; area: string | null } {
  if (fulfillment === "PICKUP") {
    if (!cfg.pickupEnabled) throw new AppError(400, "NO_PICKUP", "This shop doesn't offer pickup. Please choose delivery.");
    return { fee: 0, area: null };
  }
  if (!cfg.deliveryEnabled) throw new AppError(400, "NO_DELIVERY", "This shop doesn't deliver. Please choose pickup.");
  let fee = cfg.deliveryFee;
  let areaName: string | null = null;
  if (cfg.areas.length > 0) {
    const found = cfg.areas.find((a) => a.name.toLowerCase() === (area ?? "").trim().toLowerCase());
    if (!found) throw new AppError(400, "BAD_AREA", "Please choose your delivery area.");
    fee = found.fee;
    areaName = found.name;
  } else if (area && area.trim()) {
    areaName = area.trim().slice(0, 60);
  }
  if (cfg.freeDeliveryOver != null && subtotal >= cfg.freeDeliveryOver) fee = 0;
  return { fee: round6(fee), area: areaName };
}

// ---------- حساب السلة ----------
export interface ProductForPricing {
  id: string;
  name: string;
  price: number;
  stock: number | null;
  active: boolean;
  options: ProductOption[];
  coverPhotoId: string | null;
}

export interface CartLineInput {
  productId: string;
  qty: number;
  options?: Record<string, unknown> | null;
}

export interface PricedLine {
  productId: string;
  name: string;
  options: Record<string, string>;
  price: number;
  qty: number;
  photoId: string | null;
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function soldOutMessage(name: string, left: number) {
  return left <= 0 ? `Sorry, ${name} is sold out.` : `Only ${left} left of ${name}. Please lower the quantity.`;
}

// بيحسب كل حاجة من بيانات الداتابيز بس (السعر اللي جاي من العميل بيتجاهل خالص)
export function priceCart(lines: CartLineInput[], products: ProductForPricing[], cfg: DeliveryConfig, fulfillment: "DELIVERY" | "PICKUP", area?: string | null) {
  if (lines.length === 0) throw new AppError(400, "EMPTY_CART", "Your cart is empty.");
  if (lines.length > MAX_LINES) throw new AppError(400, "TOO_MANY_LINES", `Up to ${MAX_LINES} different items per order.`);
  const byId = new Map(products.map((p) => [p.id, p]));
  const priced: PricedLine[] = [];
  const need = new Map<string, number>();
  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p || !p.active) throw new AppError(400, "UNAVAILABLE", "One of the items in your cart is no longer available. Please remove it and try again.");
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY) throw new AppError(400, "BAD_QTY", `Quantity must be between 1 and ${MAX_QTY}.`);
    const options = matchOptions(p.name, p.options, line.options);
    // نفس المنتج بنفس الاختيارات مرتين في السلة = سطر واحد
    const same = priced.find((x) => x.productId === p.id && JSON.stringify(x.options) === JSON.stringify(options));
    if (same) same.qty += line.qty;
    else priced.push({ productId: p.id, name: p.name, options, price: p.price, qty: line.qty, photoId: p.coverPhotoId });
    need.set(p.id, (need.get(p.id) ?? 0) + line.qty);
  }
  for (const [id, qty] of need) {
    const p = byId.get(id)!;
    if (p.stock != null && p.stock < qty) throw new AppError(409, "OUT_OF_STOCK", soldOutMessage(p.name, p.stock));
  }
  const subtotal = round6(priced.reduce((s, l) => s + l.price * l.qty, 0));
  const delivery = deliveryFeeFor(cfg, fulfillment, area, subtotal);
  return { lines: priced, need, subtotal, deliveryFee: delivery.fee, area: delivery.area, total: round6(subtotal + delivery.fee) };
}

// الإلغاء بيرجّع المخزون: كمية كل منتج في الطلب
export function stockToReturn(items: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const id = typeof it?.productId === "string" ? it.productId : null;
    const qty = Number(it?.qty);
    if (id && Number.isInteger(qty) && qty > 0) out.set(id, (out.get(id) ?? 0) + qty);
  }
  return out;
}

// تغيير حالة الطلب: الملغي مايرجعش
export function canChangeStatus(from: string, to: OrderStatus): boolean {
  if (from === to) return true;
  return from !== "CANCELLED";
}

// ---------- مدخلات التاجر ----------
export const settingsInput = z
  .object({
    brandName: optText(80),
    tagline: optText(140),
    about: optText(2000),
    logoDataUrl: imageDataUrl(LOGO_MAX_CHARS, "The logo").nullable().optional(),
    coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable().optional(),
    accentColor: HEX.optional(),
    whatsapp: optText(30),
    phone: optText(30),
    email: z.string().trim().max(200).email("Check the email").nullable().optional().or(z.literal("").transform(() => null)),
    instagram: optText(120),
    address: optText(300),
    deliveryEnabled: z.boolean().optional(),
    deliveryFee: money.optional(),
    freeDeliveryOver: money.nullable().optional(),
    deliveryAreas: areasSchema.optional(),
    pickupEnabled: z.boolean().optional(),
    pickupAddress: optText(300),
    merchantEmail: z.string().trim().max(200).email("Check the email").nullable().optional().or(z.literal("").transform(() => null)),
  })
  .strict();

export const categoryInput = z.object({ name: z.string().trim().min(1, "Give the category a name").max(60) });
export const idOrderInput = z.object({ ids: z.array(z.string().uuid()).max(MAX_PRODUCTS) });

const productBase = z.object({
  name: z.string().trim().min(1, "Give the product a name").max(120),
  description: optText(4000),
  categoryId: z.string().uuid().nullable().optional(),
  price: money,
  comparePrice: money.nullable().optional(),
  sku: optText(60),
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  options: optionsSchema.optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
});

const comparePriceRule = (p: { price?: number; comparePrice?: number | null }, ctx: z.RefinementCtx) => {
  if (p.comparePrice != null && p.price != null && !(p.comparePrice > p.price))
    ctx.addIssue({ code: "custom", path: ["comparePrice"], message: "The old price must be higher than the price (or leave it empty)" });
};
export const productInput = productBase.superRefine(comparePriceRule);
export const productPatch = productBase.partial().superRefine(comparePriceRule);

export const photoInput = z.object({ dataUrl: imageDataUrl(PHOTO_MAX_CHARS, "The photo") });

export const orderPatch = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    trackingUrl: z
      .string()
      .trim()
      .max(1000)
      .refine((v) => !v || /^https:\/\//i.test(v), "The tracking link must start with https://")
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v || null)),
    note: optText(1000),
  })
  .strict();

// ---------- طلب العميل ----------
export const checkoutInput = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qty: z.number().int().min(1).max(MAX_QTY),
        options: z.record(z.string().max(40), z.string().max(40)).optional().nullable(),
      })
    )
    .min(1, "Your cart is empty")
    .max(MAX_LINES),
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().min(6).max(30),
  customerEmail: z.string().trim().max(200).email().optional().nullable().or(z.literal("").transform(() => null)),
  fulfillment: z.enum(["DELIVERY", "PICKUP"]),
  area: z.string().trim().max(60).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
  paymentMethodId: z.string().max(64).optional().nullable(),
});
export type CheckoutInput = z.infer<typeof checkoutInput>;

// صورة data URL -> bytes + نوع (للعرض العام)
export function decodeDataUrl(dataUrl: string | null | undefined): { mime: string; bytes: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}
