// أسعار خدمات الحجز: لكل خدمة سعر (متخزن بالدولار زي كل المبالغ)، والعميل
// بيختار خدمة أو أكتر والإجمالي بيتحسب هنا على السيرفر من الأسعار المحفوظة -
// أبدًا مش من اللي الفرونت بيبعته
//
// servicePrices = { "<اسم الخدمة>": سعر بالدولار }
// - لو العميل اختار خدمات ليها سعر: المبلغ = مجموع أسعارها
// - لو مااختارش أو الخدمات من غير سعر: المبلغ الثابت القديم (paymentAmount)

import { activeServiceDiscounts, applyDiscount, priceView } from "../../utils/discount";

export type ServicePrices = Record<string, number>;

// أي JSON جاي من قاعدة البيانات -> خريطة نظيفة (أرقام موجبة بس)
export function readServicePrices(raw: unknown): ServicePrices {
  const out: ServicePrices = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(value);
    if (name.trim() && Number.isFinite(n) && n > 0) out[name] = Math.round(n * 1e6) / 1e6;
  }
  return out;
}

// أسعار الخدمات الموجودة فعلًا بس (خدمة اتشالت = سعرها يتشال)
export function pricesForServices(raw: unknown, services: string[]): ServicePrices {
  const prices = readServicePrices(raw);
  const out: ServicePrices = {};
  for (const s of services) if (prices[s] !== undefined) out[s] = prices[s];
  return out;
}

export function hasPricedServices(raw: unknown, services: string[]): boolean {
  return Object.keys(pricesForServices(raw, services)).length > 0;
}

// الخدمات اللي العميل اختارها (موجودة فعلًا، من غير تكرار) + المبلغ بالدولار
// بعد خصم كل خدمة (الخصم المنتهي = السعر الكامل). الإجمالي من السيرفر بس.
export function computeBookingAmount(
  settings: { services: string[]; servicePrices: unknown; paymentAmount: unknown; serviceDiscounts?: unknown },
  chosen: string[] | undefined,
  now: Date = new Date()
): { services: string[]; amount: number; fromServices: boolean } {
  const valid = Array.from(new Set((chosen ?? []).filter((s) => settings.services.includes(s))));
  const prices = discountedServicePrices(settings, now);
  const sum = valid.reduce((total, s) => total + (prices[s] ?? 0), 0);
  if (sum > 0) return { services: valid, amount: Math.round(sum * 1e6) / 1e6, fromServices: true };
  return { services: valid, amount: Number(settings.paymentAmount ?? 0) || 0, fromServices: false };
}

// سعر كل خدمة بعد الخصم الشغال دلوقتي (بالدولار)
export function discountedServicePrices(
  settings: { services: string[]; servicePrices: unknown; serviceDiscounts?: unknown },
  now: Date = new Date()
): ServicePrices {
  const prices = pricesForServices(settings.servicePrices, settings.services);
  const pcts = activeServiceDiscounts(settings.serviceDiscounts, settings.services, now);
  const out: ServicePrices = {};
  for (const [name, usd] of Object.entries(prices)) out[name] = applyDiscount(usd, pcts[name] ?? null);
  return out;
}

// للصفحة العامة: لكل خدمة بسعر -> الأصلي + نسبة الخصم (لو شغالة) + النهائي
export function publicServicePricing(
  settings: { services: string[]; servicePrices: unknown; serviceDiscounts?: unknown },
  now: Date = new Date()
) {
  const prices = pricesForServices(settings.servicePrices, settings.services);
  const pcts = activeServiceDiscounts(settings.serviceDiscounts, settings.services, now);
  const out: Record<string, { originalPrice: number; discountPct: number | null; finalPrice: number }> = {};
  for (const [name, usd] of Object.entries(prices)) out[name] = priceView(usd, pcts[name] ?? null, null, now);
  return out;
}
