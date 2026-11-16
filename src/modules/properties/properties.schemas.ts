import { z } from "zod";
import { imageDataUrl } from "../booking/page-design";

// كتالوج العقارات: التحقق من المدخلات + تحويل العقار لملخص (منطق خالص بيتختبر لوحده)

export const PURPOSES = ["SALE", "RENT"] as const;
export const PROPERTY_TYPES = ["APARTMENT", "VILLA", "TOWNHOUSE", "OFFICE", "SHOP", "LAND", "BUILDING", "WAREHOUSE", "OTHER"] as const;
export const LISTING_STATUSES = ["AVAILABLE", "RESERVED", "SOLD", "RENTED", "HIDDEN"] as const;
export const RENT_PERIODS = ["MONTH", "YEAR"] as const;
export const FURNISHED = ["FURNISHED", "SEMI", "UNFURNISHED"] as const;
export const INQUIRY_STATUSES = ["NEW", "CONTACTED", "CLOSED"] as const;

export const MAX_LISTINGS = 500;
export const MAX_PHOTOS = 30;
// الصورة كنص base64 (~1.5 ميجا صورة فعلية). الفرونت بيصغّرها قبل الرفع
export const PHOTO_MAX_CHARS = 2_100_000;
export const LOGO_MAX_CHARS = 700_000;
export const COVER_MAX_CHARS = 2_500_000;
export const MAX_FEATURES = 20;

const int = (max: number) => z.number().int("Use a whole number").min(0, "Numbers can't be negative").max(max);
const optText = (max: number) =>
  z
    .string()
    .max(max, `Please keep it under ${max} characters`)
    .transform((v) => v.trim())
    .transform((v) => (v ? v : null))
    .nullable();

// لينك الخريطة: http/https بس (مفيش javascript: ولا data:)
export const mapUrlSchema = z
  .string()
  .max(1000)
  .transform((v) => v.trim())
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "The map link must start with https://")
  .transform((v) => (v ? v : null))
  .nullable();

// المميزات: كلمات قصيرة، من غير تكرار، 20 بالكتير
export const featuresSchema = z
  .array(z.string().max(40, "Each feature must be short (40 characters max)"))
  .max(MAX_FEATURES, `Up to ${MAX_FEATURES} features`)
  .transform((list) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const f = raw.trim().replace(/\s+/g, " ");
      if (!f || seen.has(f.toLowerCase())) continue;
      seen.add(f.toLowerCase());
      out.push(f);
    }
    return out;
  });

const listingFields = {
  title: z.string().trim().min(1, "Please write a title").max(140),
  purpose: z.enum(PURPOSES),
  propertyType: z.enum(PROPERTY_TYPES),
  status: z.enum(LISTING_STATUSES),
  // بالدولار؛ null = السعر عند الطلب
  price: z.number().min(0, "The price can't be negative").max(1e12).nullable(),
  rentPeriod: z.enum(RENT_PERIODS).nullable(),
  areaSqm: int(10_000_000).nullable(),
  bedrooms: int(100).nullable(),
  bathrooms: int(100).nullable(),
  parking: int(1000).nullable(),
  furnished: z.enum(FURNISHED).nullable(),
  location: optText(160),
  mapUrl: mapUrlSchema,
  description: optText(5000),
  features: featuresSchema,
  featured: z.boolean(),
  sortOrder: z.number().int().min(-100000).max(100000),
};

export const createListingSchema = z
  .object(listingFields)
  .partial()
  .extend({ title: listingFields.title })
  .strict();
export const updateListingSchema = z.object(listingFields).partial().strict();
export type ListingInput = z.infer<typeof updateListingSchema>;

// الإيجار بس ليه "شهري/سنوي" - البيع مالوش
export function normalizeListing<T extends ListingInput>(input: T, currentPurpose?: string): T {
  const purpose = input.purpose ?? currentPurpose ?? "SALE";
  const out = { ...input };
  if (purpose === "SALE" && (input.purpose !== undefined || input.rentPeriod !== undefined)) out.rentPeriod = null;
  if (purpose === "RENT" && input.purpose === "RENT" && input.rentPeriod === undefined && currentPurpose !== "RENT") out.rentPeriod = "MONTH";
  return out;
}

export const photoSchema = z.object({ dataUrl: imageDataUrl(PHOTO_MAX_CHARS, "The photo") }).strict();
export const photoOrderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_PHOTOS) }).strict();

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #0f766e");
// أرقام بس مع كود الدولة
const phoneDigits = z
  .string()
  .max(30)
  .transform((v) => v.replace(/\D/g, ""))
  .refine((v) => v === "" || (v.length >= 7 && v.length <= 15), "Please write a full phone number with the country code")
  .transform((v) => (v ? v : null))
  .nullable();

export const settingsSchema = z
  .object({
    brandName: optText(80),
    about: optText(1500),
    logoDataUrl: imageDataUrl(LOGO_MAX_CHARS, "The logo").nullable(),
    coverDataUrl: imageDataUrl(COVER_MAX_CHARS, "The cover photo").nullable(),
    accentColor: HEX,
    whatsapp: phoneDigits,
    phone: phoneDigits,
    email: z
      .string()
      .max(160)
      .transform((v) => v.trim())
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Please write a valid email")
      .transform((v) => (v ? v : null))
      .nullable(),
    showPrices: z.boolean(),
  })
  .partial()
  .strict();

export const inquiryStatusSchema = z.object({ status: z.enum(INQUIRY_STATUSES) }).strict();

// طلب استفسار من الصفحة العامة. website = فخ للروبوتات (مخفي عن البشر)
export const publicInquirySchema = z.object({
  listingId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(2, "Please write your name").max(100),
  phone: z
    .string()
    .max(30)
    .transform((v) => v.replace(/[^\d+]/g, ""))
    .refine((v) => /^\+?\d{7,15}$/.test(v), "Please write a valid phone number"),
  email: z
    .string()
    .max(160)
    .transform((v) => v.trim())
    .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Please write a valid email")
    .transform((v) => (v ? v : null))
    .nullable()
    .optional(),
  message: z
    .string()
    .max(2000)
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  website: z.string().max(200).optional(),
});

// ---------- الملخص ----------
export interface ListingRow {
  id: string;
  title: string;
  purpose: string;
  propertyType: string;
  status: string;
  price: unknown;
  rentPeriod: string | null;
  areaSqm: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking: number | null;
  furnished: string | null;
  location: string | null;
  featured: boolean;
  sortOrder: number;
  views: number;
  createdAt: Date;
  updatedAt: Date;
  photos: { id: string }[];
}

export function priceNumber(p: unknown): number | null {
  if (p === null || p === undefined) return null;
  const n = Number(typeof p === "object" && p !== null && "toString" in p ? String(p) : p);
  return Number.isFinite(n) ? n : null;
}

// ملخص للقوائم: من غير الوصف ولا بيانات الصور (أول صورة = الغلاف)
export function toSummary(row: ListingRow, opts: { hidePrice?: boolean } = {}) {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose,
    propertyType: row.propertyType,
    status: row.status,
    price: opts.hidePrice ? null : priceNumber(row.price),
    rentPeriod: row.purpose === "RENT" ? row.rentPeriod : null,
    areaSqm: row.areaSqm,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parking: row.parking,
    furnished: row.furnished,
    location: row.location,
    featured: row.featured,
    sortOrder: row.sortOrder,
    views: row.views,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    coverPhotoId: row.photos[0]?.id ?? null,
    photoCount: row.photos.length,
  };
}

// المميز الأول، بعدين الترتيب، بعدين الأحدث
export function sortListings<T extends { featured: boolean; sortOrder: number; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder || b.createdAt.getTime() - a.createdAt.getTime());
}

// data URL -> بايتات الصورة (PNG/JPEG/WebP بس)
export function decodeImageDataUrl(dataUrl: string | null | undefined): { mime: string; bytes: Buffer } | null {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

// ترتيب الصور: لازم نفس الصور بالظبط (من غير زيادة ولا نقص ولا تكرار)
export function isSamePhotoSet(current: string[], wanted: string[]): boolean {
  if (current.length !== wanted.length) return false;
  const set = new Set(wanted);
  if (set.size !== wanted.length) return false;
  return current.every((id) => set.has(id));
}
