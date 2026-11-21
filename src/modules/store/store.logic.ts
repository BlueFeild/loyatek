import { z } from "zod";
import { imageDataUrl } from "../booking/page-design";
import { MAX_LINES, MAX_QTY, type DeliveryArea } from "./store-pricing.logic";
import { COUPON_KINDS } from "./store-pricing.logic";
import { productAttrsSchema } from "./store-catalog.logic";

// مدخلات المتجر (zod) + أدوات صغيرة. الحساب نفسه في store-pricing.logic.ts والكتالوج في store-catalog.logic.ts.
// كل الأسعار هنا بالدولار (زي ما هي متخزنة).

export const MAX_PRODUCTS = 1000;
export const MAX_PHOTOS = 12;
export const MAX_OPTION_VALUES = 20;
export const MAX_AREAS = 50;
export const MAX_COUPONS = 200;
export const MAX_BANNERS = 6;
export { MAX_LINES, MAX_QTY };
export const PHOTO_MAX_CHARS = 2_100_000; // ~1.5 MB
export const LOGO_MAX_CHARS = 700_000; // ~500 KB
export const COVER_MAX_CHARS = 2_500_000; // ~1.8 MB
export const SMALL_IMAGE_MAX_CHARS = 400_000; // صورة قسم / قيمة خاصية

export const ORDER_STATUSES = ["NEW", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PRODUCT_STATUSES = ["PUBLISHED", "HIDDEN", "DRAFT"] as const;

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
const optDate = z
  .string()
  .datetime({ offset: true, message: "Pick a valid date" })
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v ? new Date(v) : null));
const ids = (max: number) => z.array(z.string().uuid()).max(max).transform((a) => [...new Set(a)]);

// ---------- الاختيارات القديمة (options) - بنقراها بس للطلبات/السلة القديمة ----------
export interface ProductOption {
  name: string;
  values: string[];
}
export const optionsSchema = z
  .array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(40)).min(1).max(MAX_OPTION_VALUES) }))
  .max(3);
export function readOptions(raw: unknown): ProductOption[] {
  const parsed = optionsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

// ---------- التوصيل ----------
export const areasSchema = z
  .array(z.object({ name: z.string().trim().min(1, "Give each area a name").max(60), fee: money, freeOver: money.nullable().optional() }))
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
  return parsed.success ? parsed.data.map((a) => ({ name: a.name, fee: a.fee, freeOver: a.freeOver ?? null })) : [];
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
    taxEnabled: z.boolean().optional(),
    taxRate: z.number().finite().min(0).max(50, "VAT can't be more than 50%").optional(),
    pricesIncludeTax: z.boolean().optional(),
    taxLabel: optText(30),
    taxOnShipping: z.boolean().optional(),
  })
  .strict();

// ---------- الأقسام ----------
export const categoryInput = z
  .object({
    name: z.string().trim().min(1, "Give the category a name").max(60),
    parentId: z.string().uuid().nullable().optional(),
    description: optText(1000),
    imageDataUrl: imageDataUrl(SMALL_IMAGE_MAX_CHARS, "The category photo").nullable().optional(),
    slug: z.string().trim().max(80).optional(),
  })
  .strict();
export const categoryPatch = categoryInput.partial().strict();
export const idOrderInput = z.object({ ids: z.array(z.string().uuid()).max(MAX_PRODUCTS) });

// ---------- الخصائص العامة ----------
export const ATTR_DISPLAYS = ["button", "color", "image"] as const;
export const attributeInput = z
  .object({
    name: z.string().trim().min(1, "Give the attribute a name (e.g. Color)").max(40),
    display: z.enum(ATTR_DISPLAYS).optional(),
  })
  .strict();
export const attributePatch = attributeInput.partial().strict();
export const termInput = z
  .object({
    name: z.string().trim().min(1, "Give the value a name").max(40),
    color: HEX.nullable().optional(),
    imageDataUrl: imageDataUrl(SMALL_IMAGE_MAX_CHARS, "The photo").nullable().optional(),
  })
  .strict();
export const termPatch = termInput.partial().strict();
export const tagInput = z.object({ name: z.string().trim().min(1, "Give the tag a name").max(40) }).strict();

// ---------- المنتجات ----------
const productBase = z.object({
  name: z.string().trim().min(1, "Give the product a name").max(120),
  slug: z.string().trim().max(80).optional(),
  type: z.enum(["simple", "variable"]).optional(),
  shortDescription: optText(600),
  description: optText(8000),
  // قديم: قسم واحد (لسه مقبول)
  categoryId: z.string().uuid().nullable().optional(),
  categoryIds: ids(20).optional(),
  tagIds: ids(30).optional(),
  price: money,
  salePrice: money.nullable().optional(),
  saleStart: optDate,
  saleEnd: optDate,
  // قديم: "السعر القديم" = السعر العادي، والسعر = سعر التخفيض (لسه مقبول من اللوحة القديمة)
  comparePrice: money.nullable().optional(),
  sku: optText(60),
  stock: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  lowStockAt: z.number().int().min(0).max(100_000).nullable().optional(),
  backorders: z.boolean().optional(),
  attributes: productAttrsSchema.optional(),
  weightKg: z.number().finite().min(0).max(100_000).nullable().optional(),
  lengthCm: z.number().finite().min(0).max(100_000).nullable().optional(),
  widthCm: z.number().finite().min(0).max(100_000).nullable().optional(),
  heightCm: z.number().finite().min(0).max(100_000).nullable().optional(),
  relatedIds: ids(12).optional(),
  upsellIds: ids(12).optional(),
  purchaseNote: optText(1000),
  status: z.enum(PRODUCT_STATUSES).optional(),
  // قديم: active true/false = منشور/مسودة
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
});

const saleRules = (p: { price?: number; salePrice?: number | null; saleStart?: Date | null; saleEnd?: Date | null }, ctx: z.RefinementCtx) => {
  if (p.salePrice != null && p.price != null && !(p.salePrice < p.price))
    ctx.addIssue({ code: "custom", path: ["salePrice"], message: "The sale price must be lower than the regular price (or leave it empty)" });
  if (p.saleStart && p.saleEnd && !(p.saleEnd > p.saleStart)) ctx.addIssue({ code: "custom", path: ["saleEnd"], message: "The sale must end after it starts" });
};
export const productInput = productBase.superRefine(saleRules);
export const productPatch = productBase.partial().superRefine(saleRules);
export type ProductInput = z.infer<typeof productBase>;

// ---------- الاختيارات ----------
const variationFields = z.object({
  attrs: z.record(z.string().max(40), z.string().max(60)).optional(),
  price: money.nullable().optional(),
  salePrice: money.nullable().optional(),
  saleStart: optDate,
  saleEnd: optDate,
  sku: optText(60),
  stock: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
  photoId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});
export const variationInput = variationFields.extend({ attrs: z.record(z.string().max(40), z.string().max(60)) }).strict();
export const variationPatch = variationFields.strict();
export const variationsBulkInput = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    price: money.nullable().optional(),
    salePrice: money.nullable().optional(),
    stock: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
    // زوّد/قلّل المخزون بالرقم ده
    stockAdd: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const photoInput = z.object({ dataUrl: imageDataUrl(PHOTO_MAX_CHARS, "The photo") });

// ---------- الكوبونات ----------
const couponBase = z.object({
  code: z
    .string()
    .trim()
    .min(2, "The code is too short")
    .max(30)
    .regex(/^[\p{L}\p{N}_-]+$/u, "Use letters, numbers, - or _ only (no spaces)"),
  kind: z.enum(COUPON_KINDS),
  amount: z.number().finite().positive("Enter the discount").max(10_000_000),
  minSpend: money.nullable().optional(),
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  maxPerCustomer: z.number().int().min(1).max(1000).nullable().optional(),
  expiresAt: optDate,
  productIds: ids(200).optional(),
  categoryIds: ids(100).optional(),
  freeShipping: z.boolean().optional(),
  active: z.boolean().optional(),
  note: optText(200),
});
const pctRule = (c: { kind?: string; amount?: number }, ctx: z.RefinementCtx) => {
  if (c.kind === "PERCENT" && c.amount != null && c.amount > 100) ctx.addIssue({ code: "custom", path: ["amount"], message: "A percent discount can't be more than 100%" });
};
export const couponInput = couponBase.strict().superRefine(pctRule);
export const couponPatch = couponBase.partial().strict().superRefine(pctRule);

// ---------- السلايدر ----------
const bannerLink = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !v || /^https:\/\//i.test(v) || /^\/[\w\-/?=&%.]*$/.test(v), "Use a link that starts with https:// or a page of your shop")
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
export const bannerInput = z
  .object({ dataUrl: imageDataUrl(COVER_MAX_CHARS, "The slide photo"), title: optText(80), subtitle: optText(160), buttonText: optText(30), link: bannerLink })
  .strict();
export const bannerPatch = z.object({ title: optText(80), subtitle: optText(160), buttonText: optText(30), link: bannerLink }).strict();

// ---------- الطلبات ----------
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
    merchantNote: optText(2000),
  })
  .strict();

// ---------- طلب العميل ----------
const cartItems = z
  .array(
    z.object({
      productId: z.string().uuid(),
      variationId: z.string().uuid().optional().nullable(),
      qty: z.number().int().min(1).max(MAX_QTY),
      options: z.record(z.string().max(40), z.string().max(60)).optional().nullable(),
    })
  )
  .min(1, "Your cart is empty")
  .max(MAX_LINES);

export const quoteInput = z.object({
  items: cartItems,
  fulfillment: z.enum(["DELIVERY", "PICKUP"]),
  area: z.string().trim().max(60).optional().nullable(),
  couponCode: z.string().trim().max(30).optional().nullable(),
  customerPhone: z.string().trim().max(30).optional().nullable(),
});
export type QuoteInput = z.infer<typeof quoteInput>;

export const checkoutInput = quoteInput.extend({
  customerName: z.string().trim().min(1).max(100),
  customerPhone: z.string().trim().min(6).max(30),
  customerEmail: z.string().trim().max(200).email().optional().nullable().or(z.literal("").transform(() => null)),
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
