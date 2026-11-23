// حد بسيط في الذاكرة (نافذة منزلقة): كام مرة نفس المفتاح عمل حاجة في آخر X دقيقة.
// كل instance ليه عدّاده (لو اشتغل أكتر من instance الحد بيتضاعف - مقبول كحماية من التخمين)
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 20_000) {}

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  // true = وصل للحد (من غير ما يسجّل محاولة جديدة)
  isLimited(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  // يسجّل محاولة ويرجّع true لو كده عدّى الحد
  hit(key: string, now = Date.now()): boolean {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return list.length > this.limit;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

export function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
