import { seatId, seatLabel, type SeatLayout } from "./seat-layout";

// اختيار الكراسي (منطق نقي - متغطي باختبارات):
// 1) "أفضل كراسي": N كراسي جنب بعض في نفس الصف (من غير ما يعدّوا ممر)، الأقرب للمسرح وللنص
// 2) منع كرسي فاضي لوحده بين كراسي محجوزة (زي Platinumlist و Ticketmaster)

interface Segment {
  row: string;
  rowIndex: number;
  tier: string;
  // أرقام الكراسي بالترتيب
  numbers: number[];
  rowCount: number;
}

// كل صف بيتقسم عند الممرات: ممر بعد الكرسي n = الكرسي n و n+1 مش جنب بعض
function segments(layout: SeatLayout): Segment[] {
  const out: Segment[] = [];
  layout.rows.forEach((r, rowIndex) => {
    const cuts = new Set(r.aisles);
    let cur: number[] = [];
    for (let n = 1; n <= r.count; n++) {
      cur.push(n);
      if (cuts.has(n) || n === r.count) {
        out.push({ row: r.label, rowIndex, tier: r.tier, numbers: cur, rowCount: r.count });
        cur = [];
      }
    }
  });
  return out;
}

const free = (layout: SeatLayout, unavailable: Set<string>) => {
  const blocked = new Set(layout.blocked);
  return (id: string) => !blocked.has(id) && !unavailable.has(id);
};

// كام كرسي فاضي لوحده في الجزء ده (الطرف = مش متاح)
function lonelySeats(seg: Segment, isFree: (id: string) => boolean): string[] {
  const out: string[] = [];
  seg.numbers.forEach((n, i) => {
    const id = seatId(seg.row, n);
    if (!isFree(id)) return;
    const left = i > 0 && isFree(seatId(seg.row, seg.numbers[i - 1]));
    const right = i < seg.numbers.length - 1 && isFree(seatId(seg.row, seg.numbers[i + 1]));
    if (!left && !right) out.push(id);
  });
  return out;
}

// الاختيار ده بيسيب كرسي فاضي لوحده؟ بيرجع الكرسي (أو null).
// مسموح لو مفيش حل تاني في الجزء ده (كل الفاضي ناقص كرسي واحد اتاخد)
export function lonelySeatLeft(layout: SeatLayout, taken: Iterable<string>, selected: string[]): string | null {
  const takenSet = new Set(taken);
  const before = free(layout, takenSet);
  const after = free(layout, new Set([...takenSet, ...selected]));
  const picked = new Set(selected);
  for (const seg of segments(layout)) {
    const ids = seg.numbers.map((n) => seatId(seg.row, n));
    const mine = ids.filter((id) => picked.has(id)).length;
    if (!mine) continue;
    const freeBefore = ids.filter(before).length;
    if (freeBefore - mine <= 1) continue; // الجزء هيتملى تقريبًا - مفيش اختيار أحسن
    const was = new Set(lonelySeats(seg, before));
    const now = lonelySeats(seg, after).filter((id) => !was.has(id));
    if (now.length) return now[0];
  }
  return null;
}

// أفضل N كراسي جنب بعض (اختياري: فئة معينة). null = مفيش N جنب بعض
export function bestAvailable(layout: SeatLayout, taken: Iterable<string>, count: number, tierId?: string | null): string[] | null {
  if (count < 1) return null;
  const takenSet = new Set(taken);
  const isFree = free(layout, takenSet);
  const rowsTotal = Math.max(layout.rows.length, 1);
  let best: { ids: string[]; score: number } | null = null;
  for (const seg of segments(layout)) {
    if (tierId && seg.tier !== tierId) continue;
    for (let i = 0; i + count <= seg.numbers.length; i++) {
      const nums = seg.numbers.slice(i, i + count);
      const ids = nums.map((n) => seatId(seg.row, n));
      if (!ids.every(isFree)) continue;
      const center = (nums[0] + nums[nums.length - 1]) / 2;
      const rowCenter = (seg.rowCount + 1) / 2;
      // الأقرب للمسرح أهم، بعده الأقرب للنص، وبعقوبة لو هيسيب كرسي لوحده
      let score = seg.rowIndex / rowsTotal + (Math.abs(center - rowCenter) / Math.max(seg.rowCount, 1)) * 0.8;
      if (lonelySeatLeft(layout, takenSet, ids)) score += 2;
      if (!best || score < best.score) best = { ids, score };
    }
  }
  return best?.ids ?? null;
}

export const lonelySeatMessage = (id: string) =>
  `Please don't leave seat ${seatLabel(id)} empty on its own — pick it too, or choose seats next to each other.`;
