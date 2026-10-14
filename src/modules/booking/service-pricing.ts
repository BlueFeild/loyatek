// أسعار خدمات الحجز: لكل خدمة سعر (متخزن بالدولار زي كل المبالغ)، والعميل
// بيختار خدمة أو أكتر والإجمالي بيتحسب هنا على السيرفر من الأسعار المحفوظة -
// أبدًا مش من اللي الفرونت بيبعته
//
// servicePrices = { "<اسم الخدمة>": سعر بالدولار }
// - لو العميل اختار خدمات ليها سعر: المبلغ = مجموع أسعارها
// - لو مااختارش أو الخدمات من غير سعر: المبلغ الثابت القديم (paymentAmount)

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
export function computeBookingAmount(
  settings: { services: string[]; servicePrices: unknown; paymentAmount: unknown },
  chosen: string[] | undefined
): { services: string[]; amount: number; fromServices: boolean } {
  const valid = Array.from(new Set((chosen ?? []).filter((s) => settings.services.includes(s))));
  const prices = pricesForServices(settings.servicePrices, settings.services);
  const sum = valid.reduce((total, s) => total + (prices[s] ?? 0), 0);
  if (sum > 0) return { services: valid, amount: Math.round(sum * 1e6) / 1e6, fromServices: true };
  return { services: valid, amount: Number(settings.paymentAmount ?? 0) || 0, fromServices: false };
}
