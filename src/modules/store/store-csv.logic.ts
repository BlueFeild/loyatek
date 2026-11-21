// CSV للمنتجات (تصدير + استيراد زي WooCommerce). آمن من "حقن المعادلات" في Excel:
// أي خانة بتبدأ بـ = + - @ أو tab/enter بتتكتب قبلها ' — والاستيراد بيشيلها تاني.

export const CSV_MAX_ROWS = 3000;
export const CSV_MAX_CHARS = 5_000_000;
export const CSV_ATTRS = 3;

export const CSV_HEADERS = [
  "ID",
  "Type",
  "Parent",
  "SKU",
  "Name",
  "Status",
  "Featured",
  "Categories",
  "Tags",
  "Regular price",
  "Sale price",
  "Sale starts",
  "Sale ends",
  "Stock",
  "Low stock at",
  "Backorders",
  "Weight (kg)",
  "Length (cm)",
  "Width (cm)",
  "Height (cm)",
  "Short description",
  "Description",
  "Purchase note",
  ...Array.from({ length: CSV_ATTRS }, (_, i) => [`Attribute ${i + 1} name`, `Attribute ${i + 1} values`, `Attribute ${i + 1} for variations`]).flat(),
] as const;

const RISKY = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (RISKY.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// BOM عشان Excel يفهم العربي
export function toCsv(rows: unknown[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// قارئ CSV حقيقي (علامات تنصيص، فواصل وسطور جوه الخانة، "" = ")
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// الخانة بعد الاستيراد: نشيل الـ ' اللي حطيناها قدام المعادلات
export function cleanCell(v: string | undefined): string {
  const s = (v ?? "").trim();
  if (s.length > 1 && s[0] === "'" && RISKY.test(s.slice(1))) return s.slice(1);
  return s;
}

export const splitList = (v: string) =>
  v
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);

export function yes(v: string): boolean {
  return /^(yes|y|true|1|نعم|اه|أيوه)$/i.test(v.trim());
}

// رقم (يقبل 1,250.50 و ١٢٥) - فاضي = null
export function num(v: string): number | null {
  const t = v
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function dateCell(v: string): Date | null | "bad" {
  const t = v.trim();
  if (!t) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isNaN(d.getTime()) ? "bad" : d;
}

// الصفوف -> أشياء بأسامي الأعمدة (اسم العمود بيتقارن من غير مسافات/حالة، و"Regular price (QAR)" = "Regular price")
export function rowsToRecords(rows: string[][]): { records: Record<string, string>[]; missing: string[] } {
  if (rows.length === 0) return { records: [], missing: ["Name"] };
  const norm = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "");
  const want = new Map(CSV_HEADERS.map((h) => [norm(h), h]));
  const header = rows[0].map((h) => want.get(norm(cleanCell(h))) ?? null);
  const missing = ["Name"].filter((h) => !header.includes(h as (typeof CSV_HEADERS)[number]));
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { if (h) rec[h] = cleanCell(r[i]); });
    return rec;
  });
  return { records, missing };
}
