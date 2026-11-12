import { z } from "zod";

// شكل القاعة: صفوف (كل صف له حرف وعدد كراسي وفئة) + فئات أسعار + كراسي مقفولة.
// رقم الكرسي = "<الصف>-<الرقم>" زي "A-5" (الشَرطة عشان "A1"+"1" ماتتلخبطش مع "A11")
export const MAX_ROWS = 40;
export const MAX_SEATS_PER_ROW = 60;
export const MAX_TIERS = 8;
export const MAX_TOTAL_SEATS = 1500;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must look like #1E90FF");

export const tierSchema = z.object({
  id: z.string().trim().min(1).max(24).regex(/^[a-z0-9_-]+$/i, "Tier id: letters and numbers only"),
  name: z.string().trim().min(1).max(40),
  color: hex,
  // السعر بالدولار (الفرونت بيحوّل من عملة الشركة)
  price: z.number().min(0).max(100_000),
});

export const rowSchema = z.object({
  label: z.string().trim().min(1).max(4).regex(/^[A-Za-z0-9؀-ۿ]+$/, "Row name: letters or numbers only"),
  count: z.number().int().min(1).max(MAX_SEATS_PER_ROW),
  tier: z.string().trim().min(1).max(24),
  // ممر بعد الكرسي رقم كذا (مثلًا [4, 10])
  aisles: z.array(z.number().int().min(1).max(MAX_SEATS_PER_ROW)).max(10).default([]),
  // إزاحة الصف (نص كرسي) عشان شكل المسرح
  offset: z.number().min(0).max(10).default(0),
});

export const layoutSchema = z
  .object({
    stage: z.string().trim().max(40).default("STAGE"),
    rows: z.array(rowSchema).min(1).max(MAX_ROWS),
    tiers: z.array(tierSchema).min(1).max(MAX_TIERS),
    blocked: z.array(z.string().max(12)).max(MAX_TOTAL_SEATS).default([]),
  })
  .superRefine((l, ctx) => {
    const tierIds = new Set(l.tiers.map((t) => t.id));
    if (tierIds.size !== l.tiers.length) ctx.addIssue({ code: "custom", message: "Two price levels have the same id" });
    const labels = new Set<string>();
    let total = 0;
    for (const r of l.rows) {
      if (labels.has(r.label.toUpperCase())) ctx.addIssue({ code: "custom", message: `Row "${r.label}" is there twice` });
      labels.add(r.label.toUpperCase());
      if (!tierIds.has(r.tier)) ctx.addIssue({ code: "custom", message: `Row "${r.label}" has a price level that doesn't exist` });
      total += r.count;
    }
    if (total > MAX_TOTAL_SEATS) ctx.addIssue({ code: "custom", message: `Too many seats (max ${MAX_TOTAL_SEATS})` });
  });

export type SeatLayout = z.infer<typeof layoutSchema>;
export type SeatTier = z.infer<typeof tierSchema>;

export interface SeatInfo {
  id: string;
  row: string;
  number: number;
  tier: string;
  blocked: boolean;
}

export const seatId = (row: string, n: number) => `${row}-${n}`;
// "A-5" -> "A5" للعرض
export const seatLabel = (id: string) => id.replace("-", "");

// كل الكراسي الموجودة في القاعة
export function allSeats(layout: SeatLayout): SeatInfo[] {
  const blocked = new Set(layout.blocked);
  const out: SeatInfo[] = [];
  for (const r of layout.rows) {
    for (let n = 1; n <= r.count; n++) {
      const id = seatId(r.label, n);
      out.push({ id, row: r.label, number: n, tier: r.tier, blocked: blocked.has(id) });
    }
  }
  return out;
}

// قراءة شكل محفوظ في قاعدة البيانات (Json) بأمان
export function readLayout(value: unknown): SeatLayout {
  const parsed = layoutSchema.safeParse(value);
  if (!parsed.success) throw new Error("This hall layout is damaged — please edit the hall again.");
  return parsed.data;
}

// بيتأكد إن الكراسي موجودة ومش مقفولة ومش متكررة، وبيحسب السعر (بالدولار) من فئاتها
export function priceSeats(layout: SeatLayout, seatIds: string[]): { amount: number; seats: SeatInfo[] } {
  const unique = Array.from(new Set(seatIds));
  if (unique.length !== seatIds.length) throw new SeatLayoutError("The same seat was picked twice.");
  const map = new Map(allSeats(layout).map((s) => [s.id, s]));
  const tiers = new Map(layout.tiers.map((t) => [t.id, t]));
  const seats: SeatInfo[] = [];
  let amount = 0;
  for (const id of unique) {
    const s = map.get(id);
    if (!s) throw new SeatLayoutError(`Seat ${seatLabel(id)} doesn't exist.`);
    if (s.blocked) throw new SeatLayoutError(`Seat ${seatLabel(id)} isn't for sale.`);
    seats.push(s);
    amount += tiers.get(s.tier)?.price ?? 0;
  }
  return { amount: Math.round(amount * 1e6) / 1e6, seats };
}

export class SeatLayoutError extends Error {}

// تعديل عرض بعد ما اتعمل: الصفوف ثابتة، بس الفئات (اسم/لون/سعر) والكراسي المقفولة تتغير.
// كرسي اتباع مايتقفلش
export function applyEventLayoutChanges(
  layout: SeatLayout,
  changes: { tiers?: SeatTier[]; blocked?: string[] },
  takenSeatIds: Set<string>
): SeatLayout {
  const next: SeatLayout = { ...layout };
  if (changes.tiers) {
    const ids = new Set(layout.tiers.map((t) => t.id));
    const incoming = new Map(changes.tiers.map((t) => [t.id, t]));
    // نفس الفئات بس (من غير إضافة أو حذف) عشان الصفوف تفضل مربوطة
    if (incoming.size !== ids.size || [...ids].some((id) => !incoming.has(id))) {
      throw new SeatLayoutError("Price levels can be renamed or repriced here, not added or removed.");
    }
    next.tiers = layout.tiers.map((t) => ({ ...t, ...incoming.get(t.id)!, id: t.id }));
  }
  if (changes.blocked) {
    const valid = new Set(allSeats(layout).map((s) => s.id));
    const blocked = Array.from(new Set(changes.blocked)).filter((id) => valid.has(id));
    const sold = blocked.filter((id) => takenSeatIds.has(id));
    if (sold.length) throw new SeatLayoutError(`Seat ${seatLabel(sold[0])} is already booked — cancel its order first.`);
    next.blocked = blocked;
  }
  return layoutSchema.parse(next);
}

// قاعة جاهزة للبداية: 8 صفوف، أول صفين VIP
export function sampleLayout(): SeatLayout {
  const rows = "ABCDEFGH".split("").map((label, i) => ({ label, count: i < 2 ? 10 : 14, tier: i < 2 ? "vip" : "regular", aisles: i < 2 ? [5] : [4, 10], offset: i < 2 ? 2 : 0 }));
  return layoutSchema.parse({
    stage: "STAGE",
    rows,
    tiers: [
      { id: "vip", name: "VIP", color: "#F5B301", price: 40 },
      { id: "regular", name: "Regular", color: "#38BDF8", price: 15 },
    ],
    blocked: [],
  });
}
