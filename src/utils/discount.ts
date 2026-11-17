// خصومات المنيو والحجز: نسبة % (1-90) + تاريخ انتهاء اختياري.
// السيرفر هو المصدر الوحيد للسعر - الخصم المنتهي = السعر الكامل تلقائيًا.

export const DISCOUNT_MIN_PCT = 1;
export const DISCOUNT_MAX_PCT = 90;

// نسبة الخصم الشغالة دلوقتي، أو null لو مفيش / منتهي / رقم غلط
export function activeDiscountPct(pct: unknown, endsAt: Date | string | null | undefined, now: Date = new Date()): number | null {
  const n = Number(pct);
  if (pct === null || pct === undefined || !Number.isFinite(n)) return null;
  const p = Math.round(n);
  if (p < DISCOUNT_MIN_PCT || p > DISCOUNT_MAX_PCT) return null;
  if (endsAt) {
    const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
    if (!Number.isNaN(end.getTime()) && end.getTime() <= now.getTime()) return null;
  }
  return p;
}

// السعر بعد الخصم (بالدولار، 6 أرقام عشرية زي باقي المبالغ)
export function applyDiscount(usd: number, pct: number | null): number {
  const base = Number(usd) || 0;
  if (!pct) return Math.round(base * 1e6) / 1e6;
  return Math.round(base * (1 - pct / 100) * 1e6) / 1e6;
}

// شكل السعر اللي بيطلع للصفحات العامة: الأصلي + النسبة (لو شغالة) + النهائي
export function priceView(usd: number, pct: unknown, endsAt: Date | string | null | undefined, now: Date = new Date()) {
  const active = activeDiscountPct(pct, endsAt, now);
  const original = Math.round((Number(usd) || 0) * 1e6) / 1e6;
  return { originalPrice: original, discountPct: active, finalPrice: applyDiscount(original, active) };
}

// خصومات خدمات الحجز { "اسم الخدمة": { pct, endsAt } }
export type ServiceDiscount = { pct: number; endsAt: string | null };
export type ServiceDiscounts = Record<string, ServiceDiscount>;

// أي JSON من قاعدة البيانات -> خريطة نظيفة، والخدمات المش موجودة بتتشال
export function readServiceDiscounts(raw: unknown, services?: string[]): ServiceDiscounts {
  const out: ServiceDiscounts = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim() || (services && !services.includes(name))) continue;
    if (!value || typeof value !== "object") continue;
    const v = value as { pct?: unknown; endsAt?: unknown };
    const pct = Math.round(Number(v.pct));
    if (!Number.isFinite(pct) || pct < DISCOUNT_MIN_PCT || pct > DISCOUNT_MAX_PCT) continue;
    let endsAt: string | null = null;
    if (typeof v.endsAt === "string" && v.endsAt) {
      const d = new Date(v.endsAt);
      if (Number.isNaN(d.getTime())) continue;
      endsAt = d.toISOString();
    }
    out[name] = { pct, endsAt };
  }
  return out;
}

// نسب الخصم الشغالة دلوقتي بس { خدمة: % }
export function activeServiceDiscounts(raw: unknown, services: string[], now: Date = new Date()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, d] of Object.entries(readServiceDiscounts(raw, services))) {
    const pct = activeDiscountPct(d.pct, d.endsAt, now);
    if (pct) out[name] = pct;
  }
  return out;
}
