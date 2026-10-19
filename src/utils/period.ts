// فترات الحسابات: كل شهر لوحده ("2026-10")، أو من/إلى. التواريخ UTC
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { from: new Date(Date.UTC(y, mo, 1)), to: new Date(Date.UTC(y, mo + 1, 1)) };
}

// ?month=2026-10 أو ?from=2026-10-01&to=2026-10-31 -> { gte, lt } (أو null = كل الفترات)
export function periodFilter(query: Record<string, unknown>): { gte: Date; lt: Date } | null {
  if (typeof query.month === "string" && query.month) {
    const r = monthRange(query.month);
    return r ? { gte: r.from, lt: r.to } : null;
  }
  const from = typeof query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? new Date(`${query.from}T00:00:00Z`) : null;
  const to = typeof query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? new Date(`${query.to}T00:00:00Z`) : null;
  if (!from && !to) return null;
  return { gte: from ?? new Date(0), lt: to ? new Date(to.getTime() + 86400000) : new Date(8640000000000000) };
}
