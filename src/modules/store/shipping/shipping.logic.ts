import { z } from "zod";
import { AppError } from "../../../core/errors";
import { round6 } from "../store-catalog.logic";
import type { DeliveryArea, DeliveryConfig } from "../store-pricing.logic";
import { CARRIERS, type CarrierCode, type CarrierRate, type Parcel, type ShipAddress } from "./shipping.types";

// طرق الشحن (منطق نقي - متغطي باختبارات). كل المبالغ USD.
// الطريقة القديمة (deliveryEnabled + المناطق + الاستلام) بتتحول لطرق LOCAL + PICKUP لو التاجر لسه ماعملش طرق جديدة،
// فالمتاجر القديمة شغالة زي ما هي بالظبط.
//   FLAT    = سعر ثابت (ولدول معينة بس لو اتحددت)
//   ZONES   = سعر حسب المنطقة: دولة / مدينة / حي
//   LOCAL   = توصيل محلي: العميل بيختار منطقته من لستة (زي القديم)
//   PICKUP  = استلام من المحل (ببلاش)
//   FREE    = شحن مجاني (لو الطلب فوق مبلغ معيّن)
//   CARRIER = سعر لحظي من Aramex / FedEx / DHL (+ زيادة % أو مبلغ ثابت اختياري)

export const METHOD_TYPES = ["FLAT", "ZONES", "LOCAL", "PICKUP", "FREE", "CARRIER"] as const;
export type MethodType = (typeof METHOD_TYPES)[number];
export const MAX_METHODS = 20;
export const MAX_ZONES = 50;

const money = z.number().finite().min(0, "Prices can't be negative").max(1_000_000);
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Use 2-letter country codes (e.g. QA)")
  .transform((v) => v.toUpperCase());
const countries = z.array(country).max(250).transform((a) => [...new Set(a)]);
const names = z.array(z.string().trim().min(1).max(60)).max(200).transform((a) => [...new Set(a.map((x) => x.trim()))]);
const label = z.string().trim().min(1, "Give the shipping method a name").max(60);
const estimate = z.string().trim().max(40).nullable().optional().transform((v) => v || null);
const freeOver = money.nullable().optional().transform((v) => v ?? null);
const base = {
  id: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, "Bad method id"),
  label,
  enabled: z.boolean().optional().default(true),
  estimate,
  freeOver,
};

const areaSchema = z.object({ name: z.string().trim().min(1, "Give each area a name").max(60), fee: money, freeOver: money.nullable().optional().transform((v) => v ?? null) });
const zoneSchema = z.object({
  name: z.string().trim().min(1, "Give each zone a name").max(60),
  countries: countries.default([]),
  cities: names.default([]),
  areas: names.default([]),
  fee: money,
  freeOver: money.nullable().optional().transform((v) => v ?? null),
});

export const methodSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("FLAT"), fee: money, countries: countries.default([]) }).strict(),
  z.object({ ...base, type: z.literal("ZONES"), zones: z.array(zoneSchema).min(1, "Add at least one zone").max(MAX_ZONES) }).strict(),
  z.object({ ...base, type: z.literal("LOCAL"), fee: money.default(0), areas: z.array(areaSchema).max(MAX_ZONES).default([]) }).strict(),
  z.object({ ...base, type: z.literal("PICKUP"), address: z.string().trim().max(300).nullable().optional().transform((v) => v || null) }).strict(),
  z.object({ ...base, type: z.literal("FREE"), minOrder: money.nullable().optional().transform((v) => v ?? null), countries: countries.default([]) }).strict(),
  z
    .object({
      ...base,
      type: z.literal("CARRIER"),
      carrier: z.enum(CARRIERS),
      // فاضي = كل الخدمات اللي الشركة بترجعها
      services: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
      markupPct: z.number().finite().min(0).max(200).default(0),
      handlingFee: money.default(0),
      countries: countries.default([]),
    })
    .strict(),
]);
export type ShippingMethod = z.infer<typeof methodSchema>;

export const methodsSchema = z
  .array(methodSchema)
  .max(MAX_METHODS, `Up to ${MAX_METHODS} shipping methods`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((m, i) => {
      if (seen.has(m.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "Two shipping methods have the same id" });
      seen.add(m.id);
      if (m.type === "LOCAL") {
        const n = new Set<string>();
        m.areas.forEach((a, j) => {
          if (n.has(a.name.toLowerCase())) ctx.addIssue({ code: "custom", path: [i, "areas", j, "name"], message: `The area "${a.name}" is there twice` });
          n.add(a.name.toLowerCase());
        });
      }
    });
  });

export const originSchema = z
  .object({
    name: z.string().trim().min(1, "Write the sender name").max(100),
    company: z.string().trim().max(100).nullable().optional().transform((v) => v || null),
    phone: z.string().trim().max(30).refine((v) => v.replace(/\D/g, "").length >= 6, "Write a valid phone number"),
    email: z.string().trim().max(200).email("Check the email").nullable().optional().or(z.literal("").transform(() => null)),
    line1: z.string().trim().min(3, "Write the street address").max(200),
    line2: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
    city: z.string().trim().min(1, "Write the city").max(80),
    state: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
    postalCode: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
    country,
  })
  .strict();
export type ShippingOrigin = z.infer<typeof originSchema>;

export const packageSchema = z
  .object({
    // منتج من غير وزن = الوزن ده
    itemWeightKg: z.number().finite().min(0.01).max(500).default(0.5),
    // وزن الكرتونة نفسها
    boxWeightKg: z.number().finite().min(0).max(100).default(0.2),
    lengthCm: z.number().finite().min(1).max(300).default(30),
    widthCm: z.number().finite().min(1).max(300).default(20),
    heightCm: z.number().finite().min(1).max(300).default(10),
  })
  .strict();
export type ShippingPackage = z.infer<typeof packageSchema>;
export const DEFAULT_PACKAGE: ShippingPackage = { itemWeightKg: 0.5, boxWeightKg: 0.2, lengthCm: 30, widthCm: 20, heightCm: 10 };

export function readOrigin(raw: unknown): ShippingOrigin | null {
  const p = originSchema.safeParse(raw);
  return p.success ? p.data : null;
}
export function readPackage(raw: unknown): ShippingPackage {
  const p = packageSchema.safeParse(raw ?? {});
  return p.success ? p.data : DEFAULT_PACKAGE;
}

// الطريقة القديمة → طرق: توصيل محلي (نفس السعر/المناطق/المجاني فوق) + استلام
export function legacyMethods(cfg: DeliveryConfig, pickupAddress: string | null): ShippingMethod[] {
  const out: ShippingMethod[] = [];
  if (cfg.deliveryEnabled)
    out.push({ id: "local", type: "LOCAL", label: "Delivery", enabled: true, estimate: null, freeOver: cfg.freeDeliveryOver, fee: cfg.deliveryFee, areas: cfg.areas.map((a) => ({ name: a.name, fee: a.fee, freeOver: a.freeOver ?? null })) });
  if (cfg.pickupEnabled) out.push({ id: "pickup", type: "PICKUP", label: "Pickup", enabled: true, estimate: null, freeOver: null, address: pickupAddress });
  return out;
}

export function readShippingMethods(raw: unknown, legacy: DeliveryConfig, pickupAddress: string | null): { methods: ShippingMethod[]; legacy: boolean } {
  if (raw == null) return { methods: legacyMethods(legacy, pickupAddress), legacy: true };
  const p = methodsSchema.safeParse(raw);
  return { methods: p.success ? p.data : [], legacy: false };
}

// ---------- عنوان العميل ----------
export interface Destination {
  country?: string | null;
  city?: string | null;
  area?: string | null;
  postalCode?: string | null;
}
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const inList = (list: string[], v: string | null | undefined) => list.length === 0 || list.some((x) => same(x, v));
export const countryAllowed = (list: string[], c: string | null | undefined) => list.length === 0 || (!!c && list.includes(c.toUpperCase()));

// أنسب منطقة: اللي بتحدد الحي > المدينة > الدولة > الكل. التعادل = الأول في اللستة
export function matchZone<T extends { countries: string[]; cities: string[]; areas: string[] }>(zones: T[], dest: Destination): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const z of zones) {
    if (!countryAllowed(z.countries, dest.country)) continue;
    if (!inList(z.cities, dest.city)) continue;
    if (!inList(z.areas, dest.area)) continue;
    const score = (z.areas.length ? 4 : 0) + (z.cities.length ? 2 : 0) + (z.countries.length ? 1 : 0);
    if (score > bestScore) {
      best = z;
      bestScore = score;
    }
  }
  return best;
}

// زيادة التاجر على سعر الشركة: % + مبلغ ثابت
export const withMarkup = (usd: number, markupPct: number, handlingFee: number) => round6(usd * (1 + Math.max(0, markupPct) / 100) + Math.max(0, handlingFee));

// مجاني: بالكوبون أو فوق مبلغ معيّن
export function applyFree(fee: number, freeOverUsd: number | null, goods: number, couponFree: boolean): { fee: number; free: "coupon" | "threshold" | null } {
  if (fee <= 0) return { fee: 0, free: null };
  if (couponFree) return { fee: 0, free: "coupon" };
  if (freeOverUsd != null && goods >= freeOverUsd) return { fee: 0, free: "threshold" };
  return { fee: round6(fee), free: null };
}

// وزن السلة: كل منتج بوزنه (أو الوزن الافتراضي) × الكمية + وزن الكرتونة
export function cartParcel(lines: { productId: string; qty: number }[], weights: Map<string, number | null>, pkg: ShippingPackage): Parcel {
  let kg = pkg.boxWeightKg;
  for (const l of lines) {
    const w = weights.get(l.productId);
    kg += (w != null && w > 0 ? w : pkg.itemWeightKg) * l.qty;
  }
  return { weightKg: Math.max(0.1, Math.round(kg * 1000) / 1000), lengthCm: pkg.lengthCm, widthCm: pkg.widthCm, heightCm: pkg.heightCm };
}

// ---------- الخيارات اللي بتظهر للعميل ----------
export interface CarrierRateUsd extends CarrierRate {
  usd: number;
}
export type CarrierQuoteResult = { ok: true; rates: CarrierRateUsd[] } | { ok: false; reason: string };

export interface ShippingOption {
  // methodId أو methodId:SERVICE للشركات
  id: string;
  methodId: string;
  type: MethodType;
  label: string;
  fee: number;
  free: "coupon" | "threshold" | null;
  estimate: string | null;
  carrier: CarrierCode | null;
  service: string | null;
  // توصيل محلي بمناطق: العميل لازم يختار منطقة
  needsArea: boolean;
  areaMissing: boolean;
  area: string | null;
  fulfillment: "DELIVERY" | "PICKUP";
}

export interface OptionsResult {
  options: ShippingOption[];
  // طرق مش متاحة للعنوان ده (للتاجر / للعميل: "اكتب دولتك")
  unavailable: { methodId: string; label: string; reason: string }[];
}

// الطرق اللي محتاجة دولة/مدينة العميل
export const needsAddressFields = (methods: ShippingMethod[]) =>
  methods.some((m) => m.enabled && (m.type === "ZONES" || m.type === "CARRIER" || ((m.type === "FLAT" || m.type === "FREE") && m.countries.length > 0)));

// homeCountry = دولة المحل: التوصيل المحلي مابيظهرش لعنوان في دولة تانية
export function shippingOptions(methods: ShippingMethod[], dest: Destination, goods: number, couponFree: boolean, carrier: Map<string, CarrierQuoteResult>, homeCountry: string | null = null): OptionsResult {
  const options: ShippingOption[] = [];
  const unavailable: OptionsResult["unavailable"] = [];
  const opt = (m: ShippingMethod, fee: number, freeOverUsd: number | null, extra: Partial<ShippingOption> = {}): ShippingOption => {
    const f = m.type === "PICKUP" ? { fee: 0, free: null } : applyFree(fee, freeOverUsd, goods, couponFree);
    return {
      id: m.id,
      methodId: m.id,
      type: m.type,
      label: m.label,
      fee: f.fee,
      free: f.free,
      estimate: m.estimate,
      carrier: null,
      service: null,
      needsArea: false,
      areaMissing: false,
      area: null,
      fulfillment: m.type === "PICKUP" ? "PICKUP" : "DELIVERY",
      ...extra,
    };
  };
  const no = (m: ShippingMethod, reason: string) => unavailable.push({ methodId: m.id, label: m.label, reason });

  for (const m of methods) {
    if (!m.enabled) continue;
    switch (m.type) {
      case "PICKUP":
        options.push(opt(m, 0, null));
        break;
      case "FLAT":
        if (!countryAllowed(m.countries, dest.country)) no(m, dest.country ? "Not available for your country" : "Choose your country");
        else options.push(opt(m, m.fee, m.freeOver));
        break;
      case "FREE":
        if (!countryAllowed(m.countries, dest.country)) no(m, dest.country ? "Not available for your country" : "Choose your country");
        else if (m.minOrder != null && goods < m.minOrder) no(m, "MIN_ORDER");
        else options.push(opt(m, 0, null));
        break;
      case "LOCAL": {
        if (homeCountry && dest.country && dest.country.toUpperCase() !== homeCountry) {
          no(m, "Not available for your country");
          break;
        }
        if (m.areas.length === 0) {
          options.push(opt(m, m.fee, m.freeOver, { area: dest.area?.trim() ? dest.area.trim().slice(0, 60) : null }));
          break;
        }
        const found = m.areas.find((a) => same(a.name, dest.area));
        if (found) options.push(opt(m, found.fee, found.freeOver ?? m.freeOver, { needsArea: true, area: found.name }));
        else {
          // لسه مااختارش: بنعرض أقل سعر وبنعلّم إنه محتاج منطقة
          const cheapest = m.areas.reduce((x, a) => (a.fee < x.fee ? a : x), m.areas[0]);
          options.push(opt(m, cheapest.fee, cheapest.freeOver ?? m.freeOver, { needsArea: true, areaMissing: true }));
        }
        break;
      }
      case "ZONES": {
        const z = matchZone(m.zones, dest);
        if (!z) no(m, dest.country ? "Not available for your address" : "Choose your country");
        else options.push(opt(m, z.fee, z.freeOver ?? m.freeOver, { area: z.name }));
        break;
      }
      case "CARRIER": {
        if (!countryAllowed(m.countries, dest.country)) {
          no(m, dest.country ? "Not available for your country" : "Choose your country");
          break;
        }
        const r = carrier.get(m.id);
        if (!r) {
          no(m, dest.country && dest.city ? "Not available" : "Choose your country and city");
          break;
        }
        if (!r.ok) {
          no(m, r.reason);
          break;
        }
        const allowed = r.rates.filter((x) => m.services.length === 0 || m.services.includes(x.service));
        if (!allowed.length) no(m, "No service for this address");
        for (const rate of allowed) {
          const est = m.estimate ?? (rate.estimatedDays ? `${rate.estimatedDays}d` : null);
          options.push(opt(m, withMarkup(rate.usd, m.markupPct, m.handlingFee), m.freeOver, { id: `${m.id}:${rate.service}`, label: `${m.label} · ${rate.serviceName}`, carrier: m.carrier, service: rate.service, estimate: est }));
        }
        break;
      }
    }
  }
  return { options, unavailable };
}

// اختيار العميل: لازم يكون من الخيارات المتاحة دلوقتي (السعر من هنا بس - مش من المتصفح)
export function pickOption(result: OptionsResult, optionId: string | null | undefined, fulfillmentHint: "DELIVERY" | "PICKUP" | null | undefined): ShippingOption {
  let o: ShippingOption | undefined;
  if (optionId) {
    o = result.options.find((x) => x.id === optionId);
    if (!o) {
      const methodId = optionId.split(":")[0];
      const why = result.unavailable.find((u) => u.methodId === methodId);
      if (why?.reason === "MIN_ORDER") throw new AppError(400, "SHIPPING_UNAVAILABLE", "Your order is below the amount for free shipping. Please choose another shipping option.");
      throw new AppError(409, "SHIPPING_UNAVAILABLE", "That shipping option isn't available for your address any more. Please choose another one.");
    }
  } else {
    // واجهة قديمة (من غير اختيار): استلام = أول استلام، توصيل = أول طريقة مش شركة شحن
    o = fulfillmentHint === "PICKUP" ? result.options.find((x) => x.type === "PICKUP") : result.options.find((x) => x.type !== "PICKUP" && x.type !== "CARRIER") ?? result.options.find((x) => x.type !== "PICKUP");
    if (!o) {
      if (fulfillmentHint === "PICKUP") throw new AppError(400, "NO_PICKUP", "This shop doesn't offer pickup. Please choose delivery.");
      throw new AppError(400, "NO_DELIVERY", "This shop doesn't deliver to this address. Please choose pickup or another address.");
    }
  }
  if (o.areaMissing) throw new AppError(400, "BAD_AREA", "Please choose your delivery area.");
  return o;
}

// سعر الشركة بعملتها → دولار (عملة مش معروفة عندنا = الخيار مايظهرش)
export function rateToUsd(amount: number, currency: string, supported: (c: string) => boolean, rateFor: (c: string) => number): number | null {
  const c = currency.toUpperCase();
  if (!supported(c)) return null;
  const r = rateFor(c);
  if (!(r > 0) || !(amount > 0)) return null;
  return round6(amount / r);
}

// مفتاح الكاش لسعر الشركة (نفس السلة + نفس العنوان = نفس السعر لكام دقيقة)
export function rateCacheKey(tenantId: string, methodCarrier: CarrierCode, mode: string, origin: ShipAddress, dest: Destination, parcel: Parcel, declaredUsd: number): string {
  return [
    tenantId,
    methodCarrier,
    mode,
    origin.country,
    origin.city.toLowerCase(),
    origin.postalCode ?? "",
    (dest.country ?? "").toUpperCase(),
    (dest.city ?? "").trim().toLowerCase(),
    (dest.postalCode ?? "").trim().toLowerCase(),
    parcel.weightKg.toFixed(2),
    parcel.lengthCm,
    parcel.widthCm,
    parcel.heightCm,
    Math.round(declaredUsd),
  ].join("|");
}

// للعرض في الإعدادات القديمة (المناطق)
export type { DeliveryArea };
