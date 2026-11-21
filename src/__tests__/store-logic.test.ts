import { describe, expect, it } from "vitest";
import { canChangeStatus, couponInput, productInput, productPatch, readAreas, settingsInput } from "../modules/store/store.logic";
import {
  allCombinations,
  checkParent,
  customKey,
  descendantsOf,
  effectivePrice,
  filterAndSort,
  isSoldOut,
  labelsOf,
  normalizeSearch,
  priceSummary,
  productAttrsSchema,
  resolveAttrs,
  signatureOf,
  slugify,
  uniqueSlug,
  validVariationAttrs,
  variationSale,
  type GlobalAttrInfo,
  type ListItem,
  type VariationRow,
} from "../modules/store/store-catalog.logic";
import {
  applyCoupon,
  deliveryFeeFor,
  phoneKey,
  priceLines,
  quoteCart,
  stockToReturn,
  taxFor,
  type CouponRule,
  type DeliveryConfig,
  type ProductForPricing,
  type TaxConfig,
} from "../modules/store/store-pricing.logic";
import { csvCell, cleanCell, parseCsv, rowsToRecords, toCsv } from "../modules/store/store-csv.logic";
import { lookInput, mergeLook, readLook } from "../modules/store/store-look.logic";

const NOW = new Date("2026-11-21T12:00:00Z");
const cfg: DeliveryConfig = { deliveryEnabled: true, deliveryFee: 5, freeDeliveryOver: 100, areas: [], pickupEnabled: true };
const noTax: TaxConfig = { enabled: false, rate: 0, inclusive: true, onShipping: false, label: null };
const fmt = (n: number) => `$${n}`;

// خصائص: لون عام (أحمر/أزرق) + مقاس خاص (S/M)
const COLOR = "aaaaaaaa-1111-4111-8111-111111111111";
const RED = "aaaaaaaa-2222-4222-8222-222222222221";
const BLUE = "aaaaaaaa-2222-4222-8222-222222222222";
const globals = new Map<string, GlobalAttrInfo>([
  [COLOR, { id: COLOR, name: "Color", slug: "color", display: "color", terms: [{ id: RED, name: "Red", slug: "red", color: "#ff0000", hasImage: false }, { id: BLUE, name: "Blue", slug: "blue", color: "#0000ff", hasImage: false }] }],
]);
const attrs = productAttrsSchema.parse([
  { attributeId: COLOR, termIds: [RED, BLUE], forVariations: true },
  { name: "Size", values: ["S", "M"], forVariations: true },
  { name: "Material", values: ["Cotton"] },
]);
const resolved = resolveAttrs(attrs, globals);
const kColor = `g:${COLOR}`;
const kSize = customKey("Size");

const v = (id: string, a: Record<string, string>, extra: Partial<VariationRow> = {}): VariationRow => ({ id, attrs: a, price: null, salePrice: null, saleStart: null, saleEnd: null, sku: null, stock: null, photoId: null, enabled: true, sortOrder: 0, ...extra });

const tee: ProductForPricing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tee",
  type: "variable",
  price: 20,
  salePrice: null,
  saleStart: null,
  saleEnd: null,
  sku: "TEE",
  stock: null,
  backorders: false,
  active: true,
  categoryIds: ["cat-women"],
  coverPhotoId: "p1",
  purchaseNote: "Wash cold",
  attrs: resolved,
  variations: [
    v("v-red-s", { [kColor]: RED, [kSize]: "S" }, { stock: 2, sku: "TEE-R-S" }),
    v("v-red-m", { [kColor]: RED, [kSize]: "M" }, { price: 25, stock: 0 }),
    v("v-blue-s", { [kColor]: BLUE, [kSize]: "S" }, { salePrice: 15 }),
    v("v-blue-m", { [kColor]: BLUE, [kSize]: "M" }, { enabled: false }),
  ],
};
const mug: ProductForPricing = { ...tee, id: "22222222-2222-4222-8222-222222222222", name: "Mug", type: "simple", price: 10, sku: "MUG", stock: 5, categoryIds: ["cat-home"], attrs: [], variations: [], purchaseNote: null };

describe("store catalog: slugs + nested categories", () => {
  it("slugify keeps Arabic and makes unique slugs", () => {
    expect(slugify("Summer Dresses!")).toBe("summer-dresses");
    expect(slugify("عطور شرقية")).toBe("عطور-شرقية");
    expect(slugify("!!!", "x")).toBe("x");
    expect(uniqueSlug("red", ["red", "red-2"])).toBe("red-3");
  });
  it("descendants, depth and no cycles", () => {
    const cats = [
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
      { id: "d", parentId: null },
    ];
    expect([...descendantsOf(cats, "a")].sort()).toEqual(["a", "b", "c"]);
    expect(() => checkParent(cats, "a", "c")).toThrow(/inside itself/);
    expect(() => checkParent(cats, "a", "a")).toThrow(/inside itself/);
    expect(() => checkParent(cats, null, "c")).toThrow(/3 levels/);
    expect(() => checkParent(cats, "d", "c")).toThrow(/3 levels/);
    expect(() => checkParent(cats, null, "zzz")).toThrow(/doesn't exist/);
    expect(() => checkParent(cats, null, "b")).not.toThrow();
    expect(() => checkParent(cats, "a", "d")).toThrow(/3 levels/); // a has 2 levels under it
  });
});

describe("store attributes + variations", () => {
  it("attribute input: keys, duplicates, empty values", () => {
    expect(attrs[0].key).toBe(kColor);
    expect(attrs[1].key).toBe(kSize);
    expect(productAttrsSchema.safeParse([{ name: "Size", values: ["S"] }, { name: "size", values: ["M"] }]).success).toBe(false);
    expect(productAttrsSchema.safeParse([{ name: "Size", values: [] }]).success).toBe(false);
    expect(productAttrsSchema.safeParse([{ values: ["x"] }]).success).toBe(false);
    // المفتاح القديم بيفضل لو الاسم اتغير
    expect(productAttrsSchema.parse([{ key: kSize, name: "Taille", values: ["S"] }])[0].key).toBe(kSize);
  });
  it("combinations, validity and labels", () => {
    const combos = allCombinations(resolved);
    expect(combos).toHaveLength(4);
    expect(new Set(combos.map(signatureOf)).size).toBe(4);
    expect(validVariationAttrs(resolved, { [kColor]: RED, [kSize]: "S" })).toBe(true);
    expect(validVariationAttrs(resolved, { [kColor]: RED })).toBe(false);
    expect(validVariationAttrs(resolved, { [kColor]: "nope", [kSize]: "S" })).toBe(false);
    expect(labelsOf(resolved, { [kColor]: BLUE, [kSize]: "M" })).toEqual({ Color: "Blue", Size: "M" });
    expect(signatureOf({ b: "1", a: "2" })).toBe("a=2|b=1");
  });
  it("sale price only inside its dates", () => {
    const f = { price: 100, salePrice: 80, saleStart: new Date("2026-11-20T00:00:00Z"), saleEnd: new Date("2026-11-22T00:00:00Z") };
    expect(effectivePrice(f, NOW)).toMatchObject({ price: 80, onSale: true });
    expect(effectivePrice(f, new Date("2026-11-23T00:00:00Z"))).toMatchObject({ price: 100, onSale: false });
    expect(effectivePrice({ ...f, saleStart: null, saleEnd: null }, NOW).price).toBe(80);
    expect(effectivePrice({ ...f, salePrice: 120 }, NOW).price).toBe(100);
    // الاختيار من غير سعر = سعر المنتج وتخفيضه، وبسعر خاص = تخفيضه هو بس
    expect(variationSale(f, { price: null, salePrice: null, saleStart: null, saleEnd: null })).toBe(f);
    expect(variationSale(f, { price: 90, salePrice: null, saleStart: null, saleEnd: null })).toMatchObject({ price: 90, salePrice: null });
  });
  it("stock: variation stock, shared product stock, backorders", () => {
    expect(isSoldOut({ stock: null, backorders: false }, { stock: 0 })).toBe(true);
    expect(isSoldOut({ stock: 3, backorders: false }, { stock: null })).toBe(false);
    expect(isSoldOut({ stock: 0, backorders: false }, { stock: null })).toBe(true);
    expect(isSoldOut({ stock: 0, backorders: true }, { stock: 0 })).toBe(false);
  });
  it("price summary of a variable product = range of the available choices", () => {
    const s = priceSummary({ ...tee, variations: tee.variations }, NOW);
    expect(s.minPrice).toBe(15); // blue S on sale
    expect(s.maxPrice).toBe(20); // red M (25) is sold out, blue M disabled
    expect(s.onSale).toBe(true);
    expect(s.maxDiscountPct).toBe(25);
    expect(s.soldOut).toBe(false);
    expect(priceSummary({ ...tee, variations: tee.variations.map((x) => ({ ...x, stock: 0 })) }, NOW).soldOut).toBe(true);
    expect(priceSummary({ ...tee, variations: [] }, NOW).soldOut).toBe(true);
  });
});

describe("store pricing: cart", () => {
  it("uses server prices per variation and merges same lines", () => {
    const r = priceLines(
      [
        { productId: tee.id, variationId: "v-blue-s", qty: 1 },
        { productId: tee.id, variationId: "v-blue-s", qty: 1 },
        { productId: mug.id, qty: 2 },
      ],
      [tee, mug],
      NOW
    );
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ qty: 2, price: 15, regularPrice: 20, options: { Color: "Blue", Size: "S" }, stockFrom: null });
    expect(r.subtotal).toBe(50);
    expect(r.productNeed.get(mug.id)).toBe(2);
  });
  it("variation stock, sold out and disabled choices", () => {
    expect(() => priceLines([{ productId: tee.id, variationId: "v-red-s", qty: 3 }], [tee], NOW)).toThrow(/Only 2 left/);
    expect(() => priceLines([{ productId: tee.id, variationId: "v-red-m", qty: 1 }], [tee], NOW)).toThrow(/sold out/);
    expect(() => priceLines([{ productId: tee.id, variationId: "v-blue-m", qty: 1 }], [tee], NOW)).toThrow(/isn't available/);
    expect(() => priceLines([{ productId: tee.id, qty: 1 }], [tee], NOW)).toThrow(/choose Color/);
    const r = priceLines([{ productId: tee.id, variationId: "v-red-s", qty: 2 }], [tee], NOW);
    expect(r.variationNeed.get("v-red-s")).toEqual({ productId: tee.id, qty: 2 });
    expect(r.lines[0].sku).toBe("TEE-R-S");
  });
  it("old carts (options by name) still work", () => {
    const r = priceLines([{ productId: tee.id, qty: 1, options: { Color: "Red", Size: "S" } }], [tee], NOW);
    expect(r.lines[0].variationId).toBe("v-red-s");
  });
  it("shared product stock across choices", () => {
    const shared = { ...tee, stock: 3, variations: tee.variations.map((x) => ({ ...x, stock: null })) };
    expect(() => priceLines([{ productId: tee.id, variationId: "v-red-s", qty: 2 }, { productId: tee.id, variationId: "v-blue-s", qty: 2 }], [shared], NOW)).toThrow(/Only 3 left of Tee/);
    expect(priceLines([{ productId: tee.id, variationId: "v-red-s", qty: 2 }], [shared], NOW).productNeed.get(tee.id)).toBe(2);
  });
  it("refuses hidden / unknown products and empty carts", () => {
    expect(() => priceLines([{ productId: mug.id, qty: 1 }], [{ ...mug, active: false }], NOW)).toThrow(/no longer available/);
    expect(() => priceLines([{ productId: "x", qty: 1 }], [mug], NOW)).toThrow(/no longer available/);
    expect(() => priceLines([], [mug], NOW)).toThrow(/empty/);
    expect(() => priceLines([{ productId: mug.id, qty: 0 }], [mug], NOW)).toThrow(/Quantity/);
    expect(() => priceLines([{ productId: mug.id, qty: 6 }], [mug], NOW)).toThrow(/Only 5 left/);
    expect(priceLines([{ productId: mug.id, qty: 6 }], [{ ...mug, backorders: true }], NOW).subtotal).toBe(60);
  });
});

describe("store pricing: delivery + tax", () => {
  it("flat fee, free over, pickup, zones with their own free-over, coupon free shipping", () => {
    expect(deliveryFeeFor(cfg, "DELIVERY", null, 50).fee).toBe(5);
    expect(deliveryFeeFor(cfg, "DELIVERY", null, 100)).toMatchObject({ fee: 0, free: "threshold" });
    expect(deliveryFeeFor(cfg, "DELIVERY", null, 50, true)).toMatchObject({ fee: 0, free: "coupon" });
    expect(deliveryFeeFor(cfg, "PICKUP", null, 10).fee).toBe(0);
    expect(() => deliveryFeeFor({ ...cfg, pickupEnabled: false }, "PICKUP", null, 10)).toThrow(/pickup/);
    expect(() => deliveryFeeFor({ ...cfg, deliveryEnabled: false }, "DELIVERY", null, 10)).toThrow(/deliver/);
    const zones = { ...cfg, areas: [{ name: "Doha", fee: 3, freeOver: 30 }, { name: "Al Wakrah", fee: 8 }] };
    expect(deliveryFeeFor(zones, "DELIVERY", "doha", 35)).toMatchObject({ fee: 0, area: "Doha" });
    expect(deliveryFeeFor(zones, "DELIVERY", "Al Wakrah", 35)).toMatchObject({ fee: 8, area: "Al Wakrah" });
    expect(() => deliveryFeeFor(zones, "DELIVERY", "Mars", 20)).toThrow(/area/);
  });
  it("VAT included or added, with or without shipping", () => {
    expect(taxFor(noTax, 100, 10).amount).toBe(0);
    expect(taxFor({ ...noTax, enabled: true, rate: 5, inclusive: true }, 105, 10)).toEqual({ amount: 5, included: true });
    expect(taxFor({ ...noTax, enabled: true, rate: 5, inclusive: false }, 100, 10)).toEqual({ amount: 5, included: false });
    expect(taxFor({ ...noTax, enabled: true, rate: 10, inclusive: false, onShipping: true }, 100, 10).amount).toBe(11);
    readAreas([{ name: "Doha", fee: 1 }]); // قراية بأمان
    expect(readAreas("junk")).toEqual([]);
  });
});

describe("store coupons", () => {
  const base: CouponRule = { id: "c1", code: "SAVE10", kind: "PERCENT", amount: 10, minSpend: null, maxUses: null, usedCount: 0, maxPerCustomer: null, expiresAt: null, productIds: [], categoryIds: new Set(), freeShipping: false, active: true };
  const cart = priceLines([{ productId: tee.id, variationId: "v-red-s", qty: 2 }, { productId: mug.id, qty: 3 }], [tee, mug], NOW); // 40 + 30
  it("percent, fixed cart, fixed product", () => {
    expect(applyCoupon(base, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(7);
    expect(applyCoupon({ ...base, kind: "FIXED_CART", amount: 100 }, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(70);
    expect(applyCoupon({ ...base, kind: "FIXED_PRODUCT", amount: 4 }, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(20);
    expect(applyCoupon({ ...base, kind: "FIXED_PRODUCT", amount: 50 }, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(70);
  });
  it("products / categories restrictions", () => {
    expect(applyCoupon({ ...base, productIds: [mug.id] }, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(3);
    expect(applyCoupon({ ...base, categoryIds: new Set(["cat-women"]) }, cart.lines, cart.subtotal, NOW, 0, fmt).discount).toBe(4);
    expect(() => applyCoupon({ ...base, categoryIds: new Set(["cat-none"]) }, cart.lines, cart.subtotal, NOW, 0, fmt)).toThrow(/doesn't apply/);
  });
  it("expiry, min spend, usage limits, inactive", () => {
    expect(() => applyCoupon({ ...base, expiresAt: new Date("2026-11-01") }, cart.lines, cart.subtotal, NOW, 0, fmt)).toThrow(/expired/);
    expect(() => applyCoupon({ ...base, minSpend: 100 }, cart.lines, cart.subtotal, NOW, 0, fmt)).toThrow(/Spend at least \$100/);
    expect(() => applyCoupon({ ...base, maxUses: 5, usedCount: 5 }, cart.lines, cart.subtotal, NOW, 0, fmt)).toThrow(/used up/);
    expect(() => applyCoupon({ ...base, maxPerCustomer: 1 }, cart.lines, cart.subtotal, NOW, 1, fmt)).toThrow(/already used/);
    expect(() => applyCoupon({ ...base, active: false }, cart.lines, cart.subtotal, NOW, 0, fmt)).toThrow(/isn't valid/);
    expect(phoneKey("+974 5555-1234")).toBe("55551234");
  });
  it("full quote: coupon + free shipping + VAT added", () => {
    const q = quoteCart({
      lines: [{ productId: mug.id, qty: 3 }],
      products: [mug],
      delivery: cfg,
      tax: { enabled: true, rate: 10, inclusive: false, onShipping: false, label: "VAT" },
      fulfillment: "DELIVERY",
      coupon: { ...base, kind: "FIXED_CART", amount: 5, freeShipping: true },
      now: NOW,
      fmt,
    });
    expect(q).toMatchObject({ subtotal: 30, discount: 5, deliveryFee: 0, freeDelivery: "coupon", tax: 2.5, taxIncluded: false, taxLabel: "VAT", total: 27.5 });
    const q2 = quoteCart({ lines: [{ productId: mug.id, qty: 1 }], products: [mug], delivery: cfg, tax: { enabled: true, rate: 5, inclusive: true, onShipping: true, label: null }, fulfillment: "DELIVERY", now: NOW, fmt });
    expect(q2.total).toBe(15);
    expect(q2.tax).toBeCloseTo(0.714286, 5);
  });
});

describe("store orders + inputs", () => {
  it("stock goes back to where it came from (old orders = product)", () => {
    const back = stockToReturn([
      { productId: "a", qty: 2 },
      { productId: "a", qty: 1, stockFrom: "product" },
      { productId: "t", variationId: "v1", qty: 2, stockFrom: "variation" },
      { productId: "t", variationId: "v2", qty: 2, stockFrom: null },
      { bad: true },
    ]);
    expect(back.products.get("a")).toBe(3);
    expect(back.variations.get("v1")).toBe(2);
    expect(back.variations.has("v2")).toBe(false);
    expect(canChangeStatus("NEW", "SHIPPED")).toBe(true);
    expect(canChangeStatus("CANCELLED", "NEW")).toBe(false);
  });
  it("sale price lower than the regular price, sale dates in order", () => {
    expect(productInput.safeParse({ name: "A", price: 10, salePrice: 8 }).success).toBe(true);
    expect(productInput.safeParse({ name: "A", price: 10, salePrice: 10 }).success).toBe(false);
    expect(productInput.safeParse({ name: "A", price: 10, saleStart: "2026-12-02T00:00:00Z", saleEnd: "2026-12-01T00:00:00Z" }).success).toBe(false);
    expect(productPatch.safeParse({ salePrice: null }).success).toBe(true);
    expect(productInput.safeParse({ name: "A", price: -1 }).success).toBe(false);
    expect(productInput.safeParse({ name: "A", price: 1, categoryIds: ["not-a-uuid"] }).success).toBe(false);
  });
  it("settings + coupons validation", () => {
    expect(settingsInput.safeParse({ logoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(settingsInput.safeParse({ hacker: 1 }).success).toBe(false);
    expect(settingsInput.safeParse({ deliveryAreas: [{ name: "Doha", fee: 2 }, { name: "doha", fee: 3 }] }).success).toBe(false);
    expect(settingsInput.safeParse({ taxRate: 60 }).success).toBe(false);
    expect(settingsInput.parse({ email: "" }).email).toBeNull();
    expect(couponInput.safeParse({ code: "SAVE 10", kind: "PERCENT", amount: 10 }).success).toBe(false);
    expect(couponInput.safeParse({ code: "SAVE10", kind: "PERCENT", amount: 120 }).success).toBe(false);
    expect(couponInput.safeParse({ code: "خصم10", kind: "FIXED_CART", amount: 5 }).success).toBe(true);
  });
});

describe("store shop filters + sort + search", () => {
  const item = (id: string, extra: Partial<ListItem>): ListItem => ({
    id,
    name: id,
    sku: null,
    categoryIds: [],
    tagIds: [],
    termIds: [],
    featured: false,
    sortOrder: 0,
    createdAt: NOW,
    soldCount: 0,
    summary: { minPrice: 10, maxPrice: 10, minRegular: 10, maxRegular: 10, onSale: false, soldOut: false, stockLeft: null, maxDiscountPct: 0 },
    searchText: normalizeSearch(id),
    ...extra,
  });
  const s = (min: number, max = min, more: object = {}) => ({ minPrice: min, maxPrice: max, minRegular: min, maxRegular: max, onSale: false, soldOut: false, stockLeft: null, maxDiscountPct: 0, ...more });
  const items = [
    item("red dress", { categoryIds: ["dresses"], termIds: [RED], summary: s(50), soldCount: 3, createdAt: new Date("2026-11-01") }),
    item("blue dress", { categoryIds: ["dresses"], termIds: [BLUE], summary: s(30, 40, { onSale: true }), soldCount: 9, createdAt: new Date("2026-11-10") }),
    item("عباية سوداء", { categoryIds: ["abayas"], summary: s(80, 80, { soldOut: true }), createdAt: new Date("2026-11-15") }),
    item("mug", { featured: true, categoryIds: ["home"], summary: s(5), createdAt: new Date("2026-10-01") }),
  ];
  const names = (list: ListItem[]) => list.map((x) => x.id);
  const set = (list: ListItem[]) => names(list).sort();
  it("category, terms, price, stock, sale", () => {
    expect(set(filterAndSort(items, { categoryIds: new Set(["dresses"]) }))).toEqual(["blue dress", "red dress"]);
    expect(set(filterAndSort(items, { terms: [[RED, BLUE]] }))).toEqual(["blue dress", "red dress"]);
    expect(names(filterAndSort(items, { terms: [[BLUE]] }))).toEqual(["blue dress"]);
    expect(set(filterAndSort(items, { min: 35, max: 60 }))).toEqual(["blue dress", "red dress"]);
    expect(names(filterAndSort(items, { inStock: true })).includes("عباية سوداء")).toBe(false);
    expect(names(filterAndSort(items, { onSale: true }))).toEqual(["blue dress"]);
  });
  it("sorts (sold out always last) and Arabic search", () => {
    expect(names(filterAndSort(items, { sort: "price_asc" }))).toEqual(["mug", "blue dress", "red dress", "عباية سوداء"]);
    expect(names(filterAndSort(items, { sort: "price_desc" }))).toEqual(["red dress", "blue dress", "mug", "عباية سوداء"]);
    expect(names(filterAndSort(items, { sort: "popular" }))[0]).toBe("blue dress");
    expect(names(filterAndSort(items, { sort: "newest" }))[0]).toBe("blue dress");
    expect(names(filterAndSort(items, { sort: "featured" }))[0]).toBe("mug");
    expect(names(filterAndSort(items, { q: "عبايه" }))).toEqual(["عباية سوداء"]);
    expect(names(filterAndSort(items, { q: "DRESS blue" }))).toEqual(["blue dress"]);
  });
});

describe("store CSV + look", () => {
  it("formula-safe cells and round trip", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(cleanCell("'=1+1")).toBe("=1+1");
    expect(cleanCell("'hello")).toBe("'hello");
    const text = toCsv([["Name", "Description", "Regular price (QAR)"], ["Oud, gold", 'Line 1\nLine "2"', "=1+1"]]);
    const rows = parseCsv(text);
    expect(rows).toEqual([["Name", "Description", "Regular price (QAR)"], ["Oud, gold", 'Line 1\nLine "2"', "'=1+1"]]);
    const { records, missing } = rowsToRecords(rows);
    expect(missing).toEqual([]);
    expect(records[0]).toMatchObject({ Name: "Oud, gold", "Regular price": "=1+1" });
    expect(rowsToRecords([["Price"]]).missing).toEqual(["Name"]);
  });
  it("look: template defaults, sections order, safe reading", () => {
    const d = readLook(null, "boutique");
    expect(d.font).toBe("elegant");
    expect(d.sections.map((x) => x.id)).toContain("testimonials");
    const next = mergeLook(d, "bold", lookInput.parse({ template: "bold", applyTemplate: true, sections: [{ id: "new", on: true }, { id: "hero", on: false }] }));
    expect(next.font).toBe("bold");
    expect(next.sections[0]).toEqual({ id: "new", on: true });
    expect(next.sections).toHaveLength(8);
    expect(lookInput.safeParse({ sections: [{ id: "hero", on: true }, { id: "hero", on: false }] }).success).toBe(false);
    expect(lookInput.safeParse({ announcement: { on: true, text: "Hi", link: "javascript:alert(1)" } }).success).toBe(false);
    expect(readLook({ font: "comic", columns: 9 }, "clean")).toMatchObject({ font: "modern", columns: 4 });
  });
});
