import { createHash } from "crypto";
import { z } from "zod";
import { AppError } from "../../core/errors";

// منطق الكتالوج "النقي" (زي WooCommerce): الأقسام المتداخلة، الخصائص (عامة + خاصة بالمنتج)، الاختيارات
// (variations) وتوافيقها، سعر التخفيض بمواعيده، والمخزون (خاص بالاختيار أو مشترك للمنتج). كل الأسعار USD.

export const MAX_ATTRS_PER_PRODUCT = 10;
export const MAX_VALUES_PER_ATTR = 50;
export const MAX_VARIATIONS = 100;
export const MAX_CATEGORY_DEPTH = 3;
export const MAX_CATEGORIES = 200;
export const MAX_ATTRIBUTES = 30;
export const MAX_TERMS = 100;
export const MAX_TAGS = 300;
export const DEFAULT_LOW_STOCK = 3;

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// اسم -> رابط قصير (بيسيب الحروف العربي)
export function slugify(name: string, fallback = "item"): string {
  const s = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

// رابط فريد جوه قايمة موجودة (لو "red" موجود -> "red-2")
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()));
  if (!set.has(base)) return base;
  for (let i = 2; i < 10_000; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// مفتاح الخاصية الخاصة بالمنتج: نفس اللي الـ migration بيعمله ("c:" + أول 10 حروف من md5 للاسم)
export const customKey = (name: string) => `c:${createHash("md5").update(name.toLowerCase()).digest("hex").slice(0, 10)}`;
export const globalKey = (attributeId: string) => `g:${attributeId}`;

// ======================= الأقسام المتداخلة =======================
export interface CategoryNode {
  id: string;
  parentId: string | null;
}

// كل الأقسام اللي تحت قسم (هو نفسه + ولاده + ولاد ولاده)
export function descendantsOf(categories: CategoryNode[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
  }
  return out;
}

export function depthOf(categories: CategoryNode[], id: string | null): number {
  let d = 0;
  let cur = id;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return 99; // لفّة = غلط
    seen.add(cur);
    d++;
    cur = categories.find((c) => c.id === cur)?.parentId ?? null;
  }
  return d;
}

// الأب الجديد لازم يكون موجود، مش القسم نفسه ولا واحد من ولاده، والعمق ميزيدش عن 3
export function checkParent(categories: CategoryNode[], id: string | null, parentId: string | null) {
  if (!parentId) return;
  if (!categories.some((c) => c.id === parentId)) throw new AppError(400, "BAD_PARENT", "That parent category doesn't exist.");
  if (id && descendantsOf(categories, id).has(parentId)) throw new AppError(400, "BAD_PARENT", "A category can't go inside itself or one of its sub-categories.");
  // عمق القسم نفسه + أعمق فرع تحته
  let below = 0;
  if (id) {
    const sub = descendantsOf(categories, id);
    for (const c of sub) below = Math.max(below, depthOf(categories, c) - depthOf(categories, id));
  }
  if (depthOf(categories, parentId) + 1 + below > MAX_CATEGORY_DEPTH) throw new AppError(400, "TOO_DEEP", `Categories can go up to ${MAX_CATEGORY_DEPTH} levels deep.`);
}

// ======================= خصائص المنتج =======================
export interface ProductAttr {
  key: string;
  attributeId: string | null;
  name: string | null;
  termIds: string[];
  values: string[];
  visible: boolean;
  forVariations: boolean;
}

const attrItem = z
  .object({
    key: z.string().regex(/^(c:[0-9a-f]{10}|g:[0-9a-f-]{36})$/).optional(),
    attributeId: z.string().uuid().nullable().optional(),
    name: z.string().trim().max(40).nullable().optional(),
    termIds: z.array(z.string().uuid()).max(MAX_VALUES_PER_ATTR).optional(),
    values: z.array(z.string().trim().min(1).max(40)).max(MAX_VALUES_PER_ATTR, `Up to ${MAX_VALUES_PER_ATTR} values per attribute`).optional(),
    visible: z.boolean().optional(),
    forVariations: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if (!a.attributeId && !a.name) ctx.addIssue({ code: "custom", path: ["name"], message: "Give each attribute a name (e.g. Size)" });
  });

export const productAttrsSchema = z
  .array(attrItem)
  .max(MAX_ATTRS_PER_PRODUCT, `Up to ${MAX_ATTRS_PER_PRODUCT} attributes per product`)
  .transform((list): ProductAttr[] =>
    list.map((a) => {
      if (a.attributeId)
        return { key: globalKey(a.attributeId), attributeId: a.attributeId, name: null, termIds: [...new Set(a.termIds ?? [])], values: [], visible: a.visible ?? true, forVariations: a.forVariations ?? false };
      const name = (a.name ?? "").trim();
      // المفتاح القديم بيفضل (عشان الاختيارات المربوطة بيه ما تضيعش لو الاسم اتغير)
      const key = a.key?.startsWith("c:") ? a.key : customKey(name);
      return { key, attributeId: null, name, termIds: [], values: [...new Set(a.values ?? [])], visible: a.visible ?? true, forVariations: a.forVariations ?? false };
    })
  )
  .superRefine((list, ctx) => {
    const keys = new Set<string>();
    const names = new Set<string>();
    list.forEach((a, i) => {
      if (keys.has(a.key)) ctx.addIssue({ code: "custom", path: [i], message: "The same attribute is there twice" });
      keys.add(a.key);
      if (a.name) {
        const n = a.name.toLowerCase();
        if (names.has(n)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `The attribute "${a.name}" is there twice` });
        names.add(n);
      }
      if ((a.attributeId ? a.termIds.length : a.values.length) === 0) ctx.addIssue({ code: "custom", path: [i], message: "Each attribute needs at least one value" });
    });
  });

export function readAttrs(raw: unknown): ProductAttr[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductAttr[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object" || typeof (a as ProductAttr).key !== "string") continue;
    const x = a as Partial<ProductAttr>;
    out.push({
      key: x.key!,
      attributeId: typeof x.attributeId === "string" ? x.attributeId : null,
      name: typeof x.name === "string" ? x.name : null,
      termIds: Array.isArray(x.termIds) ? x.termIds.filter((t): t is string => typeof t === "string") : [],
      values: Array.isArray(x.values) ? x.values.filter((t): t is string => typeof t === "string") : [],
      visible: x.visible !== false,
      forVariations: x.forVariations === true,
    });
  }
  return out;
}

// كل قيم الخاصية كـ {id, label}: العامة id = termId، الخاصة id = النص نفسه
export interface AttrTermInfo {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  hasImage: boolean;
}
export interface GlobalAttrInfo {
  id: string;
  name: string;
  slug: string;
  display: string;
  terms: AttrTermInfo[];
}
export interface ResolvedAttr {
  key: string;
  attributeId: string | null;
  name: string;
  display: string;
  visible: boolean;
  forVariations: boolean;
  options: { id: string; label: string; color: string | null; termId: string | null; hasImage: boolean }[];
}

export function resolveAttrs(attrs: ProductAttr[], globals: Map<string, GlobalAttrInfo>): ResolvedAttr[] {
  const out: ResolvedAttr[] = [];
  for (const a of attrs) {
    if (a.attributeId) {
      const g = globals.get(a.attributeId);
      if (!g) continue; // الخاصية اتمسحت
      const chosen = new Set(a.termIds);
      const options = g.terms.filter((t) => chosen.has(t.id)).map((t) => ({ id: t.id, label: t.name, color: t.color, termId: t.id, hasImage: t.hasImage }));
      if (options.length) out.push({ key: a.key, attributeId: g.id, name: g.name, display: g.display, visible: a.visible, forVariations: a.forVariations, options });
    } else if (a.name && a.values.length) {
      out.push({ key: a.key, attributeId: null, name: a.name, display: "button", visible: a.visible, forVariations: a.forVariations, options: a.values.map((v) => ({ id: v, label: v, color: null, termId: null, hasImage: false })) });
    }
  }
  return out;
}

// ======================= الاختيارات (variations) =======================
export type VariationAttrs = Record<string, string>;

export const signatureOf = (attrs: VariationAttrs) =>
  Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join("|");

// كل التوافيق (لون × مقاس × ...) من خصائص الاختيارات
export function allCombinations(resolved: ResolvedAttr[]): VariationAttrs[] {
  const vars = resolved.filter((a) => a.forVariations);
  if (vars.length === 0) return [];
  let combos: VariationAttrs[] = [{}];
  for (const a of vars) {
    const next: VariationAttrs[] = [];
    for (const c of combos) for (const o of a.options) next.push({ ...c, [a.key]: o.id });
    combos = next;
    if (combos.length > MAX_VARIATIONS * 4) break;
  }
  return combos;
}

// الاختيار لازم يحتوي على قيمة صحيحة لكل خاصية اختيارات - ومفيش حاجة زيادة
export function validVariationAttrs(resolved: ResolvedAttr[], attrs: VariationAttrs): boolean {
  const vars = resolved.filter((a) => a.forVariations);
  if (Object.keys(attrs).length !== vars.length) return false;
  return vars.every((a) => a.options.some((o) => o.id === attrs[a.key]));
}

// اسم الاختيار للعرض: {Color: "Red", Size: "M"}
export function labelsOf(resolved: ResolvedAttr[], attrs: VariationAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of resolved) {
    if (!a.forVariations) continue;
    const o = a.options.find((x) => x.id === attrs[a.key]);
    if (o) out[a.name] = o.label;
  }
  return out;
}

export function readVariationAttrs(raw: unknown): VariationAttrs {
  const out: VariationAttrs = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

// ======================= السعر =======================
export interface SaleFields {
  price: number;
  salePrice: number | null;
  saleStart: Date | null;
  saleEnd: Date | null;
}

export function saleActive(sale: number | null, start: Date | null, end: Date | null, regular: number, now: Date) {
  return sale != null && sale < regular && (!start || now >= start) && (!end || now < end);
}

export function effectivePrice(f: SaleFields, now: Date): { price: number; regular: number; onSale: boolean; saleEnds: Date | null } {
  const onSale = saleActive(f.salePrice, f.saleStart, f.saleEnd, f.price, now);
  return { price: onSale ? f.salePrice! : f.price, regular: f.price, onSale, saleEnds: onSale ? f.saleEnd : null };
}

export interface VariationRow {
  id: string;
  attrs: VariationAttrs;
  price: number | null;
  salePrice: number | null;
  saleStart: Date | null;
  saleEnd: Date | null;
  sku: string | null;
  stock: number | null;
  photoId: string | null;
  enabled: boolean;
  sortOrder: number;
}

// سعر الاختيار: سعره الخاص (وتخفيضه الخاص)، ولو ملوش سعر = سعر المنتج وتخفيضه
export function variationSale(product: SaleFields, v: Pick<VariationRow, "price" | "salePrice" | "saleStart" | "saleEnd">): SaleFields {
  if (v.price != null || v.salePrice != null) return { price: v.price ?? product.price, salePrice: v.salePrice, saleStart: v.saleStart, saleEnd: v.saleEnd };
  return product;
}

// ======================= المخزون =======================
export interface StockProduct {
  stock: number | null;
  backorders: boolean;
}

// منين بيتخصم: الاختيار (لو ليه مخزون)، أو المنتج (مخزون مشترك)، أو مفتوح
export function stockSource(p: StockProduct, v: Pick<VariationRow, "stock"> | null): { from: "variation" | "product" | null; left: number | null } {
  if (v && v.stock != null) return { from: "variation", left: v.stock };
  if (p.stock != null) return { from: "product", left: p.stock };
  return { from: null, left: null };
}

export function isSoldOut(p: StockProduct, v: Pick<VariationRow, "stock"> | null): boolean {
  if (p.backorders) return false;
  const s = stockSource(p, v);
  return s.left != null && s.left <= 0;
}

// ======================= كارت المنتج (للقوايم والفلاتر) =======================
export interface CardInput extends SaleFields, StockProduct {
  id: string;
  type: string;
  variations: VariationRow[];
}

export interface PriceSummary {
  minPrice: number;
  maxPrice: number;
  minRegular: number;
  maxRegular: number;
  onSale: boolean;
  soldOut: boolean;
  stockLeft: number | null;
  maxDiscountPct: number;
}

export function priceSummary(p: CardInput, now: Date): PriceSummary {
  const rows = p.type === "variable" ? p.variations.filter((v) => v.enabled) : [];
  if (p.type !== "variable" || rows.length === 0) {
    const e = effectivePrice(p, now);
    const soldOut = p.type === "variable" ? true : isSoldOut(p, null);
    return { minPrice: e.price, maxPrice: e.price, minRegular: e.regular, maxRegular: e.regular, onSale: e.onSale, soldOut, stockLeft: p.stock, maxDiscountPct: e.onSale ? Math.round((1 - e.price / e.regular) * 100) : 0 };
  }
  // المتاح بس هو اللي بيحدد السعر (لو كله خلصان: كل الاختيارات)
  const available = rows.filter((v) => !isSoldOut(p, v));
  const use = available.length ? available : rows;
  const prices = use.map((v) => effectivePrice(variationSale(p, v), now));
  let pct = 0;
  for (const e of prices) if (e.onSale) pct = Math.max(pct, Math.round((1 - e.price / e.regular) * 100));
  const left = available.reduce<number | null>((sum, v) => {
    const s = stockSource(p, v);
    if (s.left == null || sum == null) return null;
    return s.from === "product" ? Math.max(sum, s.left) : sum + s.left;
  }, 0);
  return {
    minPrice: Math.min(...prices.map((e) => e.price)),
    maxPrice: Math.max(...prices.map((e) => e.price)),
    minRegular: Math.min(...prices.map((e) => e.regular)),
    maxRegular: Math.max(...prices.map((e) => e.regular)),
    onSale: prices.some((e) => e.onSale),
    soldOut: available.length === 0,
    stockLeft: left,
    maxDiscountPct: pct,
  };
}

// ======================= الفلاتر والترتيب (المتجر العام) =======================
export const SORTS = ["featured", "newest", "price_asc", "price_desc", "popular", "name"] as const;
export type SortKey = (typeof SORTS)[number];

export interface ListItem {
  id: string;
  name: string;
  sku: string | null;
  categoryIds: string[];
  tagIds: string[];
  termIds: string[]; // كل قيم الخصائص العامة الظاهرة في المنتج
  featured: boolean;
  sortOrder: number;
  createdAt: Date;
  soldCount: number;
  summary: PriceSummary;
  searchText: string;
}

export interface ListQuery {
  categoryIds?: Set<string> | null; // القسم + كل اللي تحته
  tagId?: string | null;
  // termIds مجمّعة بالخاصية: لازم يطابق قيمة واحدة على الأقل من كل خاصية
  terms?: string[][];
  min?: number | null;
  max?: number | null;
  inStock?: boolean;
  onSale?: boolean;
  q?: string | null;
  sort?: SortKey;
}

// نفس فكرة البحث: من غير تشكيل، أ/إ/آ = ا، ة = ه، ى = ي
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[ً-ٰٟ̀-ͯ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

export function filterAndSort(items: ListItem[], q: ListQuery): ListItem[] {
  const words = q.q ? normalizeSearch(q.q).split(" ").filter(Boolean) : [];
  const out = items.filter((it) => {
    if (q.categoryIds && !it.categoryIds.some((c) => q.categoryIds!.has(c))) return false;
    if (q.tagId && !it.tagIds.includes(q.tagId)) return false;
    if (q.terms?.length && !q.terms.every((group) => group.length === 0 || group.some((t) => it.termIds.includes(t)))) return false;
    if (q.min != null && it.summary.maxPrice < q.min) return false;
    if (q.max != null && it.summary.minPrice > q.max) return false;
    if (q.inStock && it.summary.soldOut) return false;
    if (q.onSale && !it.summary.onSale) return false;
    if (words.length && !words.every((w) => it.searchText.includes(w))) return false;
    return true;
  });
  const sort = q.sort ?? "featured";
  const byOrder = (a: ListItem, b: ListItem) => a.sortOrder - b.sortOrder || b.createdAt.getTime() - a.createdAt.getTime();
  const cmp: Record<SortKey, (a: ListItem, b: ListItem) => number> = {
    featured: (a, b) => Number(b.featured) - Number(a.featured) || byOrder(a, b),
    newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    price_asc: (a, b) => a.summary.minPrice - b.summary.minPrice || byOrder(a, b),
    price_desc: (a, b) => b.summary.maxPrice - a.summary.maxPrice || byOrder(a, b),
    popular: (a, b) => b.soldCount - a.soldCount || byOrder(a, b),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  // الخلصان في الآخر دايمًا
  return out.sort((a, b) => Number(a.summary.soldOut) - Number(b.summary.soldOut) || cmp[sort](a, b));
}
