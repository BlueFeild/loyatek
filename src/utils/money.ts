import { prisma } from "../config/db";

// العملة الأساسية للمنصة كلها = الدولار. كل المبالغ بتتخزن بالدولار (دقة 6
// خانات)، وبتتعرض بعملة الشركة (Tenant.displayCurrency) بسعر صرف صحيح.
// أسعار الصرف بتتحدث تلقائي كل يوم من الإنترنت، والسوبر أدمن يقدر يثبّت
// سعر أي عملة بإيده (manualRate). نفس اللستة في الفرونت (frontend/src/lib/money.ts)
export const CURRENCY_CODES = ["USD", "QAR", "EGP", "AED", "SAR", "KWD", "BHD", "OMR", "JOD", "EUR", "GBP"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];
// اسم قديم (عملة المنيو) - نفس اللستة
export const MENU_CURRENCY_CODES = CURRENCY_CODES;

// أسعار احتياطية (1 دولار = ...) لو مفيش ولا سعر متحفظ ولا الإنترنت شغال.
// عملات الخليج مربوطة بالدولار رسميًا فأسعارها ثابتة
export const FALLBACK_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  QAR: 3.64,
  AED: 3.6725,
  SAR: 3.75,
  KWD: 0.3075,
  BHD: 0.376,
  OMR: 0.3845,
  JOD: 0.709,
  EGP: 48.5,
  EUR: 0.92,
  GBP: 0.79,
};

export type Rates = Record<string, number>;

export function isCurrencyCode(c: unknown): c is CurrencyCode {
  return typeof c === "string" && (CURRENCY_CODES as readonly string[]).includes(c);
}

// --- التحويل (منطق نقي - متغطي باختبارات) ---

export function rateFor(currency: string | null | undefined, rates: Rates): number {
  const code = currency || "USD";
  if (code === "USD") return 1;
  // سعر صفر/غلط من المصدر مايتاخدش (كان هيعرض السعر بالدولار على إنه بالعملة)
  const r = rates[code];
  if (r && r > 0) return r;
  return FALLBACK_RATES[code as CurrencyCode] ?? 1;
}

// دولار -> عملة الشركة
export function fromUsd(usd: number | string, currency: string | null | undefined, rates: Rates): number {
  return (Number(usd) || 0) * rateFor(currency, rates);
}

// عملة الشركة -> دولار (للتخزين) - 6 خانات عشان الرجوع يطلع نفس الرقم بالظبط
export function toUsd(amount: number | string, currency: string | null | undefined, rates: Rates): number {
  return Math.round(((Number(amount) || 0) / rateFor(currency, rates)) * 1e6) / 1e6;
}

// مبلغ بالفعل بعملة معيّنة -> نص ("QAR 25.00" / "$25.00" / "KWD 1.250")
export function formatMoney(amount: number | string, currency: string | null | undefined = "USD"): string {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD" })
      .format(value)
      .replace(/ /g, " "); // مسافة عادية (Intl بيحط non-breaking space)
  } catch {
    return `${currency ?? ""} ${value.toFixed(2)}`.trim();
  }
}

// مبلغ متخزن بالدولار -> نص بعملة الشركة
export function formatUsdAs(usd: number | string, currency: string | null | undefined, rates: Rates): string {
  return formatMoney(fromUsd(usd, currency, rates), currency || "USD");
}

// المبلغ اللي هيتدفع فعلًا بعملة الشركة (مقرّب لخانات العملة: 2 أو 3)
export function payableAmount(usd: number | string, currency: string | null | undefined, rates: Rates): number {
  const code = currency || "USD";
  const digits = ["KWD", "BHD", "OMR", "JOD"].includes(code) ? 3 : 2;
  const f = 10 ** digits;
  return Math.round(fromUsd(usd, code, rates) * f) / f;
}

// --- أسعار الصرف (من الداتابيز + كاش دقيقة) ---

let cache: { at: number; rates: Rates } | null = null;

export function clearRatesCache() {
  cache = null;
}

// السعر الفعلي لكل عملة: اليدوي (لو السوبر أدمن ثبّته) > التلقائي > الاحتياطي
export async function getRates(): Promise<Rates> {
  if (cache && Date.now() - cache.at < 60 * 1000) return cache.rates;
  const rows = await prisma.exchangeRate.findMany();
  const rates: Rates = { ...FALLBACK_RATES };
  for (const r of rows) {
    const manual = r.manualRate != null ? Number(r.manualRate) : null;
    const auto = r.autoRate != null ? Number(r.autoRate) : null;
    const value = manual && manual > 0 ? manual : auto && auto > 0 ? auto : null;
    if (value) rates[r.currency] = value;
  }
  rates.USD = 1;
  cache = { at: Date.now(), rates };
  return rates;
}

// كل التفاصيل (للسوبر أدمن): التلقائي، اليدوي، والمستخدم فعلًا
export async function getRatesTable() {
  const rows = await prisma.exchangeRate.findMany();
  const byCode = new Map(rows.map((r) => [r.currency, r]));
  const effective = await getRates();
  return CURRENCY_CODES.map((code) => {
    const r = byCode.get(code);
    return {
      currency: code,
      autoRate: r?.autoRate != null ? Number(r.autoRate) : null,
      manualRate: r?.manualRate != null ? Number(r.manualRate) : null,
      autoUpdatedAt: r?.autoUpdatedAt ?? null,
      effectiveRate: effective[code],
      source: code === "USD" ? "base" : r?.manualRate != null ? "manual" : r?.autoRate != null ? "auto" : "fallback",
    };
  });
}

// تحديث الأسعار من الإنترنت (open.er-api.com - مجاني ومن غير مفتاح).
// لو فشل، الأسعار القديمة بتفضل زي ما هي
export async function refreshRatesFromInternet(): Promise<{ ok: boolean; updated: number; error?: string }> {
  const url = process.env.EXCHANGE_RATES_URL || "https://open.er-api.com/v6/latest/USD";
  try {
    const res = await fetch(url);
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (!res.ok || data.result === "error" || !data.rates) return { ok: false, updated: 0, error: `rates source returned ${res.status}` };
    let updated = 0;
    for (const code of CURRENCY_CODES) {
      if (code === "USD") continue;
      const rate = data.rates[code];
      if (!rate || !(rate > 0)) continue;
      await prisma.exchangeRate.upsert({
        where: { currency: code },
        create: { currency: code, autoRate: rate, autoUpdatedAt: new Date() },
        update: { autoRate: rate, autoUpdatedAt: new Date() },
      });
      updated++;
    }
    clearRatesCache();
    return { ok: true, updated };
  } catch (err) {
    return { ok: false, updated: 0, error: (err as Error)?.message };
  }
}

// عملة الشركة + الأسعار (للرسايل والدفع والإشعارات من السيرفر)
export async function getTenantMoney(tenantId: string): Promise<{ currency: string; rates: Rates }> {
  const [tenant, rates] = await Promise.all([prisma.tenant.findUnique({ where: { id: tenantId }, select: { displayCurrency: true } }), getRates()]);
  const currency = isCurrencyCode(tenant?.displayCurrency) ? tenant!.displayCurrency : "USD";
  return { currency, rates };
}

let timer: NodeJS.Timeout | null = null;
export function startExchangeRateScheduler(intervalMs = 12 * 3600 * 1000) {
  if (timer || process.env.DISABLE_RATE_REFRESH === "1") return;
  const tick = () =>
    refreshRatesFromInternet().then((r) => {
      if (!r.ok) console.warn(`[exchange-rates] refresh failed: ${r.error} — keeping last saved rates`);
    });
  setTimeout(tick, 10 * 1000).unref();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}
