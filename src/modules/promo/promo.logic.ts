import { z } from "zod";

// أكواد الخصم للحجز والمنيو - منطق نقي (متغطي باختبارات promo.logic.test.ts).
// كل المبالغ بالدولار. المتجر عنده كوبوناته الخاصة (store_coupons) ومش بيستخدم ده.

export const PROMO_SERVICES = ["booking", "menu"] as const;
export type PromoService = (typeof PROMO_SERVICES)[number];

// كل خدمة تبع أنهي اشتراك
export const PROMO_MODULE: Record<PromoService, string> = { booking: "booking", menu: "catalog" };

export const MAX_PROMOS_PER_SERVICE = 200;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const normalizePromoCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, "");

const codeSchema = z
  .string()
  .trim()
  .min(3, "The code must be at least 3 characters")
  .max(24, "The code can be up to 24 characters")
  .regex(/^[A-Za-z0-9_-]+$/, "Use English letters, numbers, - or _ only (no spaces)")
  .transform((c) => c.toUpperCase());

const base = z.object({
  code: codeSchema,
  kind: z.enum(["PERCENT", "AMOUNT"]),
  // نسبة 1-100 أو مبلغ بالدولار
  value: z.number().finite().positive("Enter the discount").max(1_000_000),
  minOrderUsd: z.number().finite().min(0).max(10_000_000).nullable().optional(),
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  active: z.boolean().optional(),
});

const pctRule = (p: { kind?: string; value?: number }, ctx: z.RefinementCtx) => {
  if (p.kind === "PERCENT" && p.value != null && p.value > 100) ctx.addIssue({ code: "custom", path: ["value"], message: "A percentage can't be more than 100" });
};
const datesRule = (p: { startsAt?: Date | null; endsAt?: Date | null }, ctx: z.RefinementCtx) => {
  if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end date must be after the start date" });
};

export const promoInput = base.strict().superRefine(pctRule).superRefine(datesRule);
export const promoPatch = base.partial().strict().superRefine(pctRule).superRefine(datesRule);

export interface PromoRule {
  id: string;
  code: string;
  kind: string; // PERCENT | AMOUNT
  value: number;
  minOrderUsd: number | null;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

export type PromoProblem =
  | { code: "PROMO_INVALID" }
  | { code: "PROMO_NOT_STARTED" }
  | { code: "PROMO_EXPIRED" }
  | { code: "PROMO_USED_UP" }
  | { code: "PROMO_MIN_ORDER"; minOrderUsd: number }
  | { code: "PROMO_NOTHING_TO_PAY" };

// ليه الكود ده مايشتغلش على المبلغ ده؟ (null = شغال)
export function promoProblem(p: PromoRule, subtotalUsd: number | null, now: Date): PromoProblem | null {
  if (!p.active) return { code: "PROMO_INVALID" };
  if (p.startsAt && p.startsAt > now) return { code: "PROMO_NOT_STARTED" };
  if (p.endsAt && p.endsAt <= now) return { code: "PROMO_EXPIRED" };
  if (p.maxUses != null && p.usedCount >= p.maxUses) return { code: "PROMO_USED_UP" };
  if (subtotalUsd != null) {
    if (p.minOrderUsd != null && p.minOrderUsd > 0 && subtotalUsd + 1e-9 < p.minOrderUsd) return { code: "PROMO_MIN_ORDER", minOrderUsd: p.minOrderUsd };
    if (subtotalUsd <= 0) return { code: "PROMO_NOTHING_TO_PAY" };
  }
  return null;
}

// قيمة الخصم (بالدولار) - عمرها ما تعدّي المبلغ نفسه
export function promoDiscount(p: Pick<PromoRule, "kind" | "value">, subtotalUsd: number): number {
  if (!(subtotalUsd > 0)) return 0;
  const raw = p.kind === "AMOUNT" ? p.value : (subtotalUsd * Math.min(Math.max(p.value, 0), 100)) / 100;
  return round6(Math.min(Math.max(raw, 0), subtotalUsd));
}

// المبلغ بعد الخصم (مش أقل من صفر)
export function totalAfterPromo(subtotalUsd: number, discountUsd: number): number {
  return round6(Math.max(0, subtotalUsd - discountUsd));
}

// رسالة واضحة للعميل. fmt = بيعرض الدولار بعملة الشركة
export function promoProblemMessage(p: PromoProblem, fmt: (usd: number) => string): string {
  switch (p.code) {
    case "PROMO_NOT_STARTED":
      return "This code isn't active yet.";
    case "PROMO_EXPIRED":
      return "This code has expired.";
    case "PROMO_USED_UP":
      return "This code has been fully used.";
    case "PROMO_MIN_ORDER":
      return `Spend at least ${fmt(p.minOrderUsd)} to use this code.`;
    case "PROMO_NOTHING_TO_PAY":
      return "There's nothing to pay yet, so the code can't be used.";
    default:
      return "This code isn't valid.";
  }
}
