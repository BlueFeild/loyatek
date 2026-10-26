import { z } from "zod";

// أسعار رسايل واتساب اللي Meta بتاخدها (مش جزء من اشتراك المنصة).
// Meta بتحاسب على كل رسالة قالب حسب دولة رقم المستلم ونوع القالب، والتاجر بيدفعها
// لـ Meta مباشرة (طريقة دفع على حساب واتساب بتاعه). الأرقام دي تقديرية بالدولار
// (rate card أكتوبر 2026) - السوبر أدمن يقدر يعدّلها، وMeta بتغيّرها من وقت للتاني

export const META_CATEGORIES = ["marketing", "utility", "authentication"] as const;
export type MetaCategory = (typeof META_CATEGORIES)[number];
export type MetaRate = Record<MetaCategory, number>;
export type MetaRateTable = Record<string, MetaRate>; // ISO دولة → الأسعار، و"OTHER" لأي دولة تانية

export const META_RATES_NOTE =
  "Estimates of Meta's per-message fees (USD), paid by you to Meta — not included in the BlueField price. Replies inside 24 hours of a customer's message are free or very low; Meta changes these rates from time to time.";

export const DEFAULT_META_RATES: MetaRateTable = {
  QA: { marketing: 0.0341, utility: 0.012, authentication: 0.012 },
  SA: { marketing: 0.0576, utility: 0.0107, authentication: 0.0107 },
  AE: { marketing: 0.0576, utility: 0.0157, authentication: 0.0157 },
  EG: { marketing: 0.0644, utility: 0.0036, authentication: 0.0036 },
  KW: { marketing: 0.0792, utility: 0.044, authentication: 0.044 },
  BH: { marketing: 0.0392, utility: 0.0091, authentication: 0.0091 },
  OM: { marketing: 0.0341, utility: 0.0247, authentication: 0.0247 },
  JO: { marketing: 0.0392, utility: 0.0091, authentication: 0.0091 },
  OTHER: { marketing: 0.0604, utility: 0.0077, authentication: 0.0077 },
};

const rate = z.number().min(0).max(5);
export const metaRateTableSchema = z.record(
  z.string().regex(/^([A-Z]{2}|OTHER)$/, "Use a 2-letter country code (e.g. QA) or OTHER"),
  z.object({ marketing: rate, utility: rate, authentication: rate })
);

// كود الدولة من رقم المستلم (أرقام بس، بكود الدولة) - الأطول الأول (مثلًا 974 قبل 97)
const DIAL_CODES: [string, string][] = [
  ["974", "QA"],
  ["966", "SA"],
  ["971", "AE"],
  ["965", "KW"],
  ["973", "BH"],
  ["968", "OM"],
  ["962", "JO"],
  ["20", "EG"],
];

export function countryForPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "").replace(/^00/, "");
  return DIAL_CODES.find(([code]) => digits.startsWith(code))?.[1] ?? "OTHER";
}

// قالب Meta (MARKETING / UTILITY / AUTHENTICATION) → نوع السعر
export function categoryForTemplate(category: string | null | undefined): MetaCategory {
  const c = (category ?? "").toLowerCase();
  return c === "utility" ? "utility" : c === "authentication" ? "authentication" : "marketing";
}

export interface CostEstimate {
  category: MetaCategory;
  currency: "USD";
  total: number;
  messages: number;
  byCountry: { country: string; messages: number; rate: number; cost: number }[];
  note: string;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// بيحسب تكلفة Meta التقريبية لقايمة أرقام (حملة) - مسؤوليته الحساب بس
export class MetaCostEstimator {
  constructor(private readonly rates: MetaRateTable) {}

  rateFor(country: string, category: MetaCategory): number {
    return (this.rates[country] ?? this.rates.OTHER ?? DEFAULT_META_RATES.OTHER)[category];
  }

  estimate(phones: string[], category: MetaCategory): CostEstimate {
    const counts = new Map<string, number>();
    for (const p of phones) {
      const c = countryForPhone(p);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const byCountry = [...counts.entries()]
      .map(([country, messages]) => {
        const r = this.rateFor(country, category);
        return { country, messages, rate: r, cost: round4(r * messages) };
      })
      .sort((a, b) => b.messages - a.messages);
    return { category, currency: "USD", messages: phones.length, total: round4(byCountry.reduce((s, x) => s + x.cost, 0)), byCountry, note: META_RATES_NOTE };
  }
}

export function mergeRates(overrides: unknown): MetaRateTable {
  const parsed = metaRateTableSchema.safeParse(overrides ?? {});
  return { ...DEFAULT_META_RATES, ...(parsed.success ? parsed.data : {}) };
}
