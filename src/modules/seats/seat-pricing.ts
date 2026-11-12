import { z } from "zod";
import { allSeats, seatLabel, type SeatLayout } from "./seat-layout";

// حساب سعر التذاكر (منطق نقي - متغطي باختبارات): سعر مبكر + كود خصم.
// كل الأرقام بالدولار. subtotal = السعر الكامل، amount = اللي العميل هيدفعه.

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export interface EarlyBird {
  pct: number | null;
  endsAt: Date | null;
}

export interface PromoRule {
  id: string;
  code: string;
  kind: string; // PERCENT | AMOUNT
  value: number;
  maxUses: number | null;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  eventId: string | null;
  tierIds: string[];
  active: boolean;
}

export const promoInput = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, "Code: letters, numbers, - and _ only")
    .transform((c) => c.toUpperCase()),
  kind: z.enum(["PERCENT", "AMOUNT"]),
  // نسبة 1-100 أو مبلغ بالدولار
  value: z.number().positive().max(100_000),
  maxUses: z.number().int().min(1).max(100_000).nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
  tierIds: z.array(z.string().max(24)).max(8).default([]),
  active: z.boolean().default(true),
}).refine((p) => p.kind !== "PERCENT" || p.value <= 100, { message: "A percentage can't be more than 100", path: ["value"] });

export function earlyBirdActive(eb: EarlyBird, now: Date): number {
  if (!eb.pct || eb.pct <= 0 || !eb.endsAt || eb.endsAt <= now) return 0;
  return Math.min(eb.pct, 90);
}

// ليه الكود ده مايشتغلش؟ (null = شغال)
export function promoProblem(p: PromoRule, eventId: string, now: Date): string | null {
  if (!p.active) return "This code isn't active.";
  if (p.startsAt && p.startsAt > now) return "This code isn't valid yet.";
  if (p.endsAt && p.endsAt <= now) return "This code has expired.";
  if (p.maxUses != null && p.usedCount >= p.maxUses) return "This code has been fully used.";
  if (p.eventId && p.eventId !== eventId) return "This code isn't for this show.";
  return null;
}

export interface PricedOrder {
  subtotal: number;
  discount: number;
  amount: number;
  // خصم الكود لوحده (عشان التقرير)
  promoDiscount: number;
  earlyBirdPct: number;
}

// السعر النهائي لمجموعة كراسي: (السعر - السعر المبكر) - الكود
export function priceOrder(layout: SeatLayout, seatIds: string[], opts: { earlyBird?: EarlyBird; promo?: PromoRule | null; now: Date }): PricedOrder {
  const tierOf = new Map(allSeats(layout).map((s) => [s.id, s.tier]));
  const price = new Map(layout.tiers.map((t) => [t.id, t.price]));
  const eb = opts.earlyBird ? earlyBirdActive(opts.earlyBird, opts.now) : 0;
  let subtotal = 0;
  let afterEarly = 0;
  let eligible = 0;
  for (const id of seatIds) {
    const tier = tierOf.get(id);
    if (!tier) throw new Error(`Seat ${seatLabel(id)} doesn't exist.`);
    const full = price.get(tier) ?? 0;
    const p = full * (1 - eb / 100);
    subtotal += full;
    afterEarly += p;
    if (opts.promo && (opts.promo.tierIds.length === 0 || opts.promo.tierIds.includes(tier))) eligible += p;
  }
  let promoDiscount = 0;
  if (opts.promo && eligible > 0) {
    promoDiscount = opts.promo.kind === "AMOUNT" ? Math.min(opts.promo.value, eligible) : (eligible * Math.min(opts.promo.value, 100)) / 100;
  }
  const amount = Math.max(0, afterEarly - promoDiscount);
  return { subtotal: round(subtotal), discount: round(subtotal - amount), amount: round(amount), promoDiscount: round(promoDiscount), earlyBirdPct: eb };
}

// الكود بيخص الكراسي دي أصلًا؟
export function promoAppliesTo(layout: SeatLayout, seatIds: string[], promo: PromoRule): boolean {
  if (promo.tierIds.length === 0) return true;
  const tierOf = new Map(allSeats(layout).map((s) => [s.id, s.tier]));
  return seatIds.some((id) => promo.tierIds.includes(tierOf.get(id) ?? ""));
}
