import { Prisma } from "@prisma/client";
import { AppError } from "../../core/errors";
import { fromUsd, getTenantMoney, toUsd } from "../../utils/money";
import { CSV_ATTRS, CSV_HEADERS, CSV_MAX_ROWS, dateCell, num, parseCsv, rowsToRecords, splitList, toCsv, yes } from "./store-csv.logic";
import { MAX_PRODUCTS, PRODUCT_STATUSES } from "./store.logic";
import {
  MAX_VARIATIONS,
  customKey,
  globalKey,
  labelsOf,
  readAttrs,
  readVariationAttrs,
  resolveAttrs,
  signatureOf,
  slugify,
  uniqueSlug,
  type ProductAttr,
} from "./store-catalog.logic";
import { StoreRepository } from "./store.repository";
import { StoreCatalogRepository } from "./store-catalog.repository";
import { StoreCatalogService } from "./store-catalog.service";

// تصدير/استيراد المنتجات كـ CSV (زي WooCommerce): صف لكل منتج + صف لكل اختيار (Type = variation، Parent = SKU أو ID المنتج).
// الأسعار بعملة الشركة. الصور مش بتتستورد (روابط من بره = خطر) - بتتضاف من اللوحة.

const round = (n: number) => Math.round(n * 1000) / 1000;
const dateStr = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const fixed = (v: Prisma.Decimal | null) => (v == null ? "" : String(Number(v)));

export interface ImportResult {
  created: number;
  updated: number;
  variations: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export class StoreCsvService {
  constructor(
    private readonly repo: StoreRepository,
    private readonly catalogRepo: StoreCatalogRepository,
    private readonly catalog: StoreCatalogService
  ) {}

  async exportCsv(tenantId: string): Promise<string> {
    const [products, categories, tags, globals, money] = await Promise.all([
      this.repo.products(tenantId),
      this.catalogRepo.categories(tenantId),
      this.catalogRepo.tags(tenantId),
      this.catalog.globals(tenantId),
      getTenantMoney(tenantId),
    ]);
    const price = (usd: Prisma.Decimal | number | null) => (usd == null ? "" : String(round(fromUsd(Number(usd), money.currency, money.rates))));
    const catPath = (id: string) => {
      const parts: string[] = [];
      for (let c = categories.find((x) => x.id === id); c; c = c.parentId ? categories.find((x) => x.id === c!.parentId) : undefined) parts.unshift(c.name);
      return parts.join(" > ");
    };
    const header = CSV_HEADERS.map((h) => (h === "Regular price" || h === "Sale price" ? `${h} (${money.currency})` : h));
    const rows: unknown[][] = [header];
    for (const p of products) {
      const attrs = readAttrs(p.attributes);
      const resolved = resolveAttrs(attrs, globals);
      const attrCells: string[] = [];
      for (let i = 0; i < CSV_ATTRS; i++) {
        const a = resolved[i];
        attrCells.push(a ? a.name : "", a ? a.options.map((o) => o.label).join("|") : "", a ? (a.forVariations ? "yes" : "no") : "");
      }
      rows.push([
        p.id,
        p.type,
        "",
        p.sku ?? "",
        p.name,
        p.status,
        p.featured ? "yes" : "no",
        p.categoryIds.map(catPath).filter(Boolean).join("|"),
        p.tagIds.map((t) => tags.find((x) => x.id === t)?.name).filter(Boolean).join("|"),
        price(p.price),
        price(p.salePrice),
        dateStr(p.saleStart),
        dateStr(p.saleEnd),
        p.stock ?? "",
        p.lowStockAt ?? "",
        p.backorders ? "yes" : "no",
        fixed(p.weightKg),
        fixed(p.lengthCm),
        fixed(p.widthCm),
        fixed(p.heightCm),
        p.shortDescription ?? "",
        p.description ?? "",
        p.purchaseNote ?? "",
        ...attrCells,
      ]);
      if (p.type !== "variable") continue;
      for (const v of p.variations) {
        const labels = labelsOf(resolved, readVariationAttrs(v.attrs));
        const vCells: string[] = [];
        for (let i = 0; i < CSV_ATTRS; i++) {
          const a = resolved.filter((x) => x.forVariations)[i];
          vCells.push(a ? a.name : "", a ? labels[a.name] ?? "" : "", a ? "yes" : "");
        }
        rows.push([v.id, "variation", p.sku || p.id, v.sku ?? "", "", v.enabled ? "PUBLISHED" : "DRAFT", "", "", "", price(v.price), price(v.salePrice), dateStr(v.saleStart), dateStr(v.saleEnd), v.stock ?? "", "", "", "", "", "", "", "", "", "", ...vCells]);
      }
    }
    return toCsv(rows);
  }

  // الاستيراد: بيعدّل لو لقى نفس الـ ID أو الـ SKU، وإلا بيعمل منتج جديد. كل صف غلط بيتسجل ويتساب.
  async importCsv(tenantId: string, text: string): Promise<ImportResult> {
    const rows = parseCsv(text);
    if (rows.length > CSV_MAX_ROWS + 1) throw new AppError(400, "TOO_MANY_ROWS", `Up to ${CSV_MAX_ROWS} rows per file.`);
    const { records, missing } = rowsToRecords(rows);
    if (missing.length) throw new AppError(400, "BAD_CSV", `The file needs a "${missing.join(", ")}" column. Export your products first to get the right columns.`);
    const money = await getTenantMoney(tenantId);
    const usd = (v: number | null) => (v == null ? null : toUsd(v, money.currency, money.rates));
    const result: ImportResult = { created: 0, updated: 0, variations: 0, skipped: 0, errors: [] };
    const fail = (row: number, message: string) => {
      result.errors.push({ row, message });
      result.skipped++;
    };

    let categories = await this.catalogRepo.categories(tenantId);
    let tags = await this.catalogRepo.tags(tenantId);
    let globals = await this.catalog.globals(tenantId);
    const all = await this.repo.products(tenantId);
    const byId = new Map(all.map((p) => [p.id, p.id]));
    const bySku = new Map(all.filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p.id]));
    let count = all.length;

    // "Women > Dresses" -> id (بيعمل الأقسام الناقصة)
    const categoryId = async (path: string): Promise<string> => {
      let parent: string | null = null;
      for (const name of path.split(">").map((x) => x.trim()).filter(Boolean)) {
        let c = categories.find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase());
        if (!c) {
          await this.catalog.createCategory(tenantId, "", { name: name.slice(0, 60), parentId: parent });
          categories = await this.catalogRepo.categories(tenantId);
          c = categories.find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase())!;
        }
        parent = c.id;
      }
      if (!parent) throw new AppError(400, "BAD_CATEGORY", "Empty category name");
      return parent;
    };
    const tagId = async (name: string) => {
      const t = await this.catalog.createTag(tenantId, name.slice(0, 40));
      tags = await this.catalogRepo.tags(tenantId);
      return t.id;
    };
    // الخاصية: لو فيه خاصية عامة بنفس الاسم = بنستخدمها (والقيم الناقصة بتتعمل)، غير كده خاصة بالمنتج
    const attrFrom = async (name: string, values: string[], forVariations: boolean): Promise<ProductAttr> => {
      const g = [...globals.values()].find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (g) {
        const termIds: string[] = [];
        for (const v of values) termIds.push(await this.catalog.ensureTerm(tenantId, g.id, v));
        globals = await this.catalog.globals(tenantId);
        return { key: globalKey(g.id), attributeId: g.id, name: null, termIds, values: [], visible: true, forVariations };
      }
      return { key: customKey(name), attributeId: null, name: name.slice(0, 40), termIds: [], values: values.map((v) => v.slice(0, 40)), visible: true, forVariations };
    };

    const parentIds = new Map<string, string>(); // SKU/ID في الملف -> id المنتج
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const rowNo = i + 2;
      const type = (r["Type"] || "simple").toLowerCase();
      try {
        if (type === "variation") continue; // بعد المنتجات
        if (type !== "simple" && type !== "variable") throw new AppError(400, "BAD_TYPE", `Type must be simple, variable or variation (got "${r["Type"]}")`);
        const name = (r["Name"] ?? "").trim().slice(0, 120);
        if (!name) throw new AppError(400, "NO_NAME", "Name is empty");
        const regular = num(r["Regular price"] ?? "");
        const sale = num(r["Sale price"] ?? "");
        const stock = num(r["Stock"] ?? "");
        const low = num(r["Low stock at"] ?? "");
        for (const [label, v] of [["Regular price", regular], ["Sale price", sale], ["Stock", stock], ["Low stock at", low]] as const)
          if (Number.isNaN(v)) throw new AppError(400, "BAD_NUMBER", `${label} isn't a number`);
        if (regular != null && regular < 0) throw new AppError(400, "BAD_PRICE", "Prices can't be negative");
        if (sale != null && regular != null && !(sale < regular)) throw new AppError(400, "BAD_SALE_PRICE", "Sale price must be lower than the regular price");
        const saleStart = dateCell(r["Sale starts"] ?? "");
        const saleEnd = dateCell(r["Sale ends"] ?? "");
        if (saleStart === "bad" || saleEnd === "bad") throw new AppError(400, "BAD_DATE", "Write dates like 2026-12-31");
        const status = (r["Status"] || "PUBLISHED").toUpperCase();
        if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) throw new AppError(400, "BAD_STATUS", "Status must be PUBLISHED, HIDDEN or DRAFT");
        const sku = (r["SKU"] ?? "").trim().slice(0, 60) || null;
        const existing = (r["ID"] && byId.get(r["ID"])) || (sku && bySku.get(sku.toLowerCase())) || null;
        if (!existing && regular == null) throw new AppError(400, "NO_PRICE", "Regular price is empty");
        if (!existing && count >= MAX_PRODUCTS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_PRODUCTS} products per shop`);

        const categoryIds: string[] = [];
        for (const path of splitList(r["Categories"] ?? "").slice(0, 20)) categoryIds.push(await categoryId(path));
        const tagIds: string[] = [];
        for (const t of splitList(r["Tags"] ?? "").slice(0, 30)) tagIds.push(await tagId(t));
        const attributes: ProductAttr[] = [];
        for (let a = 1; a <= CSV_ATTRS; a++) {
          const an = (r[`Attribute ${a} name`] ?? "").trim();
          const vals = splitList(r[`Attribute ${a} values`] ?? "").slice(0, 50);
          if (an && vals.length) attributes.push(await attrFrom(an, vals, yes(r[`Attribute ${a} for variations`] ?? "") || (type === "variable" && !(r[`Attribute ${a} for variations`] ?? "").trim())));
        }
        const dec = (k: string) => {
          const v = num(r[k] ?? "");
          if (Number.isNaN(v)) throw new AppError(400, "BAD_NUMBER", `${k} isn't a number`);
          return v;
        };
        const data: Prisma.StoreProductUncheckedUpdateManyInput = {
          name,
          type,
          sku,
          status,
          active: status !== "DRAFT",
          featured: yes(r["Featured"] ?? ""),
          categoryIds,
          categoryId: categoryIds[0] ?? null,
          tagIds,
          ...(regular != null ? { price: usd(regular)! } : {}),
          salePrice: usd(sale),
          saleStart: saleStart as Date | null,
          saleEnd: saleEnd as Date | null,
          stock: stock == null ? null : Math.round(stock),
          lowStockAt: low == null ? null : Math.round(low),
          backorders: yes(r["Backorders"] ?? ""),
          weightKg: dec("Weight (kg)"),
          lengthCm: dec("Length (cm)"),
          widthCm: dec("Width (cm)"),
          heightCm: dec("Height (cm)"),
          shortDescription: (r["Short description"] ?? "").slice(0, 600) || null,
          description: (r["Description"] ?? "").slice(0, 8000) || null,
          purchaseNote: (r["Purchase note"] ?? "").slice(0, 1000) || null,
          attributes: attributes.length ? (attributes as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        };
        let id: string;
        if (existing) {
          id = existing;
          await this.repo.updateProduct(tenantId, id, data);
          result.updated++;
        } else {
          const taken = (await this.repo.productSlugs(tenantId)).map((p) => p.slug!);
          const created = await this.repo.createProduct(tenantId, { ...(data as Prisma.StoreProductUncheckedCreateInput), name, price: usd(regular)!, slug: uniqueSlug(slugify(name, "product"), taken) });
          id = created.id;
          byId.set(id, id);
          if (sku) bySku.set(sku.toLowerCase(), id);
          count++;
          result.created++;
        }
        if (r["ID"]) parentIds.set(r["ID"].toLowerCase(), id);
        if (sku) parentIds.set(sku.toLowerCase(), id);
      } catch (e) {
        fail(rowNo, e instanceof Error ? e.message : "Couldn't read this row");
      }
    }

    // الاختيارات: بتتربط بالمنتج عن طريق Parent (SKU أو ID)
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if ((r["Type"] || "").toLowerCase() !== "variation") continue;
      const rowNo = i + 2;
      try {
        const parentKey = (r["Parent"] ?? "").trim().toLowerCase();
        const pid = parentIds.get(parentKey) ?? byId.get(r["Parent"] ?? "") ?? bySku.get(parentKey);
        if (!pid) throw new AppError(400, "NO_PARENT", `Can't find the product "${r["Parent"]}" (Parent must be its SKU or ID)`);
        const p = await this.repo.product(tenantId, pid);
        if (!p || p.type !== "variable") throw new AppError(400, "NOT_VARIABLE", "The parent product must have Type = variable");
        const resolved = resolveAttrs(readAttrs(p.attributes), globals).filter((a) => a.forVariations);
        const attrs: Record<string, string> = {};
        for (let a = 1; a <= CSV_ATTRS; a++) {
          const an = (r[`Attribute ${a} name`] ?? "").trim().toLowerCase();
          const val = (r[`Attribute ${a} values`] ?? "").trim().toLowerCase();
          if (!an) continue;
          const ra = resolved.find((x) => x.name.toLowerCase() === an);
          const o = ra?.options.find((x) => x.label.toLowerCase() === val);
          if (!ra || !o) throw new AppError(400, "BAD_VARIATION", `"${r[`Attribute ${a} name`]}: ${r[`Attribute ${a} values`]}" isn't one of the product's values`);
          attrs[ra.key] = o.id;
        }
        if (Object.keys(attrs).length !== resolved.length) throw new AppError(400, "BAD_VARIATION", "Give a value for every choice attribute of the product");
        const regular = num(r["Regular price"] ?? "");
        const sale = num(r["Sale price"] ?? "");
        const stock = num(r["Stock"] ?? "");
        if ([regular, sale, stock].some((x) => Number.isNaN(x))) throw new AppError(400, "BAD_NUMBER", "Price or stock isn't a number");
        const effRegular = regular ?? fromUsd(Number(p.price), money.currency, money.rates);
        if (sale != null && !(sale < effRegular)) throw new AppError(400, "BAD_SALE_PRICE", "Sale price must be lower than the regular price");
        const sig = signatureOf(attrs);
        let v = p.variations.find((x) => x.signature === sig) ?? null;
        if (!v) {
          if (p.variations.length >= MAX_VARIATIONS) throw new AppError(400, "TOO_MANY_VARIATIONS", `Up to ${MAX_VARIATIONS} choices per product`);
          await this.catalogRepo.createVariations(tenantId, pid, [{ attrs, signature: sig }]);
          v = (await this.catalogRepo.variations(tenantId, pid)).find((x) => x.signature === sig)!;
        }
        const ss = dateCell(r["Sale starts"] ?? "");
        const se = dateCell(r["Sale ends"] ?? "");
        await this.catalogRepo.updateVariation(tenantId, pid, v.id, {
          price: usd(regular),
          salePrice: usd(sale),
          saleStart: ss === "bad" ? null : ss,
          saleEnd: se === "bad" ? null : se,
          stock: stock == null ? null : Math.round(stock),
          sku: (r["SKU"] ?? "").trim().slice(0, 60) || null,
          enabled: (r["Status"] || "PUBLISHED").toUpperCase() !== "DRAFT",
        });
        result.variations++;
      } catch (e) {
        fail(rowNo, e instanceof Error ? e.message : "Couldn't read this row");
      }
    }
    result.errors = result.errors.slice(0, 100);
    return result;
  }
}
