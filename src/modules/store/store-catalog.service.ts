import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError, NotFoundError } from "../../core/errors";
import {
  MAX_ATTRIBUTES,
  MAX_CATEGORIES,
  MAX_TAGS,
  MAX_TERMS,
  checkParent,
  slugify,
  uniqueSlug,
  type GlobalAttrInfo,
} from "./store-catalog.logic";
import { normalizeCode } from "./store-pricing.logic";
import { MAX_BANNERS, MAX_COUPONS, type attributeInput, type attributePatch, type bannerInput, type bannerPatch, type categoryInput, type categoryPatch, type couponInput, type couponPatch, type termInput, type termPatch } from "./store.logic";
import { StoreCatalogRepository } from "./store-catalog.repository";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));

// روابط الصور العامة (نسبية - الفرونت بيحط قبلها عنوان الـ API)
export const categoryImageUrl = (slug: string, id: string, tag: string) => `/api/public/store/${slug}/category/${id}/image?v=${tag}`;
export const termImageUrl = (slug: string, id: string, tag: string) => `/api/public/store/${slug}/term/${id}/image?v=${tag}`;
export const bannerUrl = (slug: string, id: string, createdAt: Date) => `/api/public/store/${slug}/banner/${id}?v=${hash(`${id}${createdAt.getTime()}`)}`;

// إدارة الكتالوج: الأقسام المتداخلة، الخصائص العامة وقيمها، التاجز، الكوبونات، السلايدر
export class StoreCatalogService {
  constructor(private readonly repo: StoreCatalogRepository) {}

  // ======================= الأقسام =======================
  async categories(tenantId: string, slug: string) {
    const [list, counts, images] = await Promise.all([this.repo.categories(tenantId), this.repo.categoryCounts(tenantId), this.repo.categoryImageTags(tenantId)]);
    return list.map((c) => ({ ...c, productCount: counts.get(c.id) ?? 0, imageUrl: images.has(c.id) ? categoryImageUrl(slug, c.id, images.get(c.id)!) : null }));
  }

  private async categorySlug(tenantId: string, wanted: string, selfId: string | null) {
    const list = await this.repo.categories(tenantId);
    return uniqueSlug(slugify(wanted, "category"), list.filter((c) => c.id !== selfId && c.slug).map((c) => c.slug!));
  }

  async createCategory(tenantId: string, slug: string, input: z.infer<typeof categoryInput>) {
    const list = await this.repo.categories(tenantId);
    if (list.length >= MAX_CATEGORIES) throw new AppError(400, "TOO_MANY", `Up to ${MAX_CATEGORIES} categories.`);
    checkParent(list, null, input.parentId ?? null);
    const created = await this.repo.createCategory(tenantId, {
      name: input.name,
      parentId: input.parentId ?? null,
      description: input.description ?? null,
      imageDataUrl: input.imageDataUrl ?? null,
      slug: await this.categorySlug(tenantId, input.slug || input.name, null),
    });
    return (await this.categories(tenantId, slug)).find((c) => c.id === created.id)!;
  }

  async updateCategory(tenantId: string, slug: string, id: string, input: z.infer<typeof categoryPatch>) {
    const list = await this.repo.categories(tenantId);
    const cur = list.find((c) => c.id === id);
    if (!cur) throw new NotFoundError("Category not found");
    if (input.parentId !== undefined) checkParent(list, id, input.parentId);
    const data: Prisma.StoreCategoryUncheckedUpdateManyInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.parentId !== undefined) data.parentId = input.parentId;
    if (input.description !== undefined) data.description = input.description;
    if (input.imageDataUrl !== undefined) data.imageDataUrl = input.imageDataUrl;
    if (input.slug !== undefined || (!cur.slug && input.name)) data.slug = await this.categorySlug(tenantId, input.slug || input.name || cur.name, id);
    await this.repo.updateCategory(tenantId, id, data);
    return (await this.categories(tenantId, slug)).find((c) => c.id === id)!;
  }

  async deleteCategory(tenantId: string, id: string) {
    const c = await this.repo.category(tenantId, id);
    if (!c) throw new NotFoundError("Category not found");
    await this.repo.deleteCategory(tenantId, id, c.parentId);
  }

  async orderCategories(tenantId: string, slug: string, ids: string[]) {
    await this.repo.orderCategories(tenantId, ids);
    return this.categories(tenantId, slug);
  }

  // ======================= الخصائص =======================
  async attributes(tenantId: string, slug: string) {
    const [list, images] = await Promise.all([this.repo.attributes(tenantId), this.repo.termImageTags(tenantId)]);
    return list.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      display: a.display,
      sortOrder: a.sortOrder,
      terms: a.terms.map((t) => ({ id: t.id, name: t.name, slug: t.slug, color: t.color, sortOrder: t.sortOrder, imageUrl: images.has(t.id) ? termImageUrl(slug, t.id, images.get(t.id)!) : null })),
    }));
  }

  // نفس البيانات بشكل مختصر للحسابات (map بالـ id)
  async globals(tenantId: string): Promise<Map<string, GlobalAttrInfo>> {
    const [list, images] = await Promise.all([this.repo.attributes(tenantId), this.repo.termImageTags(tenantId)]);
    return new Map(
      list.map((a) => [a.id, { id: a.id, name: a.name, slug: a.slug, display: a.display, terms: a.terms.map((t) => ({ id: t.id, name: t.name, slug: t.slug, color: t.color, hasImage: images.has(t.id) })) }])
    );
  }

  async createAttribute(tenantId: string, slug: string, input: z.infer<typeof attributeInput>) {
    if ((await this.repo.countAttributes(tenantId)) >= MAX_ATTRIBUTES) throw new AppError(400, "TOO_MANY", `Up to ${MAX_ATTRIBUTES} attributes.`);
    const existing = await this.repo.attributes(tenantId);
    if (existing.some((a) => a.name.toLowerCase() === input.name.toLowerCase())) throw new AppError(409, "DUPLICATE", `You already have an attribute called "${input.name}".`);
    const a = await this.repo.createAttribute(tenantId, { name: input.name, slug: uniqueSlug(slugify(input.name, "attribute"), existing.map((x) => x.slug)), display: input.display ?? "button" });
    return (await this.attributes(tenantId, slug)).find((x) => x.id === a.id)!;
  }

  async updateAttribute(tenantId: string, slug: string, id: string, input: z.infer<typeof attributePatch>) {
    const existing = await this.repo.attributes(tenantId);
    if (!existing.some((a) => a.id === id)) throw new NotFoundError("Attribute not found");
    if (input.name && existing.some((a) => a.id !== id && a.name.toLowerCase() === input.name!.toLowerCase())) throw new AppError(409, "DUPLICATE", `You already have an attribute called "${input.name}".`);
    await this.repo.updateAttribute(tenantId, id, { ...(input.name ? { name: input.name } : {}), ...(input.display ? { display: input.display } : {}) });
    return (await this.attributes(tenantId, slug)).find((x) => x.id === id)!;
  }

  async deleteAttribute(tenantId: string, id: string) {
    if (!(await this.repo.attribute(tenantId, id))) throw new NotFoundError("Attribute not found");
    const used = await this.repo.productsUsingAttribute(tenantId, id);
    if (used > 0) throw new AppError(409, "IN_USE", used === 1 ? "1 product uses this attribute. Remove it from that product first." : `${used} products use this attribute. Remove it from them first.`);
    await this.repo.deleteAttribute(tenantId, id);
  }

  async addTerm(tenantId: string, slug: string, attributeId: string, input: z.infer<typeof termInput>) {
    const a = await this.repo.attribute(tenantId, attributeId);
    if (!a) throw new NotFoundError("Attribute not found");
    if (a.terms.length >= MAX_TERMS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_TERMS} values per attribute.`);
    if (a.terms.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) throw new AppError(409, "DUPLICATE", `"${input.name}" is already there.`);
    await this.repo.createTerm(tenantId, attributeId, {
      name: input.name,
      slug: uniqueSlug(slugify(input.name, "value"), a.terms.map((t) => t.slug)),
      color: input.color ?? null,
      imageDataUrl: input.imageDataUrl ?? null,
    });
    return (await this.attributes(tenantId, slug)).find((x) => x.id === attributeId)!;
  }

  async updateTerm(tenantId: string, slug: string, attributeId: string, termId: string, input: z.infer<typeof termPatch>) {
    const a = await this.repo.attribute(tenantId, attributeId);
    if (!a || !a.terms.some((t) => t.id === termId)) throw new NotFoundError("Value not found");
    if (input.name && a.terms.some((t) => t.id !== termId && t.name.toLowerCase() === input.name!.toLowerCase())) throw new AppError(409, "DUPLICATE", `"${input.name}" is already there.`);
    const data: Prisma.StoreAttributeTermUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.color !== undefined) data.color = input.color;
    if (input.imageDataUrl !== undefined) data.imageDataUrl = input.imageDataUrl;
    await this.repo.updateTerm(tenantId, termId, data);
    return (await this.attributes(tenantId, slug)).find((x) => x.id === attributeId)!;
  }

  async deleteTerm(tenantId: string, slug: string, attributeId: string, termId: string) {
    const a = await this.repo.attribute(tenantId, attributeId);
    if (!a || !a.terms.some((t) => t.id === termId)) throw new NotFoundError("Value not found");
    const used = await this.repo.variationsUsingTerm(tenantId, termId);
    if (used > 0) throw new AppError(409, "IN_USE", `${used} product choice${used === 1 ? "" : "s"} use this value. Remove them first.`);
    await this.repo.deleteTerm(tenantId, termId);
    return (await this.attributes(tenantId, slug)).find((x) => x.id === attributeId)!;
  }

  async orderTerms(tenantId: string, slug: string, attributeId: string, ids: string[]) {
    if (!(await this.repo.attribute(tenantId, attributeId))) throw new NotFoundError("Attribute not found");
    await this.repo.orderTerms(tenantId, attributeId, ids);
    return (await this.attributes(tenantId, slug)).find((x) => x.id === attributeId)!;
  }

  // بيضمن إن قيمة موجودة (للاستيراد): بيرجع الـ id
  async ensureTerm(tenantId: string, attributeId: string, name: string): Promise<string> {
    const a = await this.repo.attribute(tenantId, attributeId);
    if (!a) throw new NotFoundError("Attribute not found");
    const found = a.terms.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    if (a.terms.length >= MAX_TERMS) throw new AppError(400, "TOO_MANY", `"${a.name}" already has ${MAX_TERMS} values.`);
    const t = await this.repo.createTerm(tenantId, attributeId, { name: name.slice(0, 40), slug: uniqueSlug(slugify(name, "value"), a.terms.map((x) => x.slug)) });
    return t.id;
  }

  // ======================= التاجز =======================
  async tags(tenantId: string) {
    const [list, counts] = await Promise.all([this.repo.tags(tenantId), this.repo.tagCounts(tenantId)]);
    return list.map((t) => ({ id: t.id, name: t.name, slug: t.slug, productCount: counts.get(t.id) ?? 0 }));
  }
  async createTag(tenantId: string, name: string) {
    const list = await this.repo.tags(tenantId);
    const same = list.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (same) return { id: same.id, name: same.name, slug: same.slug, productCount: 0 };
    if (list.length >= MAX_TAGS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_TAGS} tags.`);
    const t = await this.repo.createTag(tenantId, name, uniqueSlug(slugify(name, "tag"), list.map((x) => x.slug)));
    return { id: t.id, name: t.name, slug: t.slug, productCount: 0 };
  }
  async renameTag(tenantId: string, id: string, name: string) {
    const list = await this.repo.tags(tenantId);
    if (!list.some((t) => t.id === id)) throw new NotFoundError("Tag not found");
    if (list.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new AppError(409, "DUPLICATE", `You already have a tag called "${name}".`);
    await this.repo.updateTag(tenantId, id, name, uniqueSlug(slugify(name, "tag"), list.filter((t) => t.id !== id).map((t) => t.slug)));
    return (await this.tags(tenantId)).find((t) => t.id === id)!;
  }
  async deleteTag(tenantId: string, id: string) {
    if (!(await this.repo.tags(tenantId)).some((t) => t.id === id)) throw new NotFoundError("Tag not found");
    await this.repo.deleteTag(tenantId, id);
  }

  // ======================= الكوبونات =======================
  private couponView(c: NonNullable<Awaited<ReturnType<StoreCatalogRepository["coupon"]>>>) {
    return { ...c, amount: Number(c.amount), minSpend: num(c.minSpend), expired: !!c.expiresAt && c.expiresAt <= new Date(), usedUp: c.maxUses != null && c.usedCount >= c.maxUses };
  }
  async coupons(tenantId: string) {
    return (await this.repo.coupons(tenantId)).map((c) => this.couponView(c));
  }

  private async checkCouponRefs(tenantId: string, productIds?: string[], categoryIds?: string[], products?: (ids: string[]) => Promise<{ id: string }[]>) {
    if (categoryIds?.length) {
      const cats = await this.repo.categories(tenantId);
      if (!categoryIds.every((id) => cats.some((c) => c.id === id))) throw new AppError(400, "BAD_CATEGORY", "One of the chosen categories doesn't exist.");
    }
    if (productIds?.length && products) {
      const found = await products(productIds);
      if (found.length !== productIds.length) throw new AppError(400, "BAD_PRODUCT", "One of the chosen products doesn't exist.");
    }
  }

  async createCoupon(tenantId: string, input: z.infer<typeof couponInput>, products: (ids: string[]) => Promise<{ id: string }[]>) {
    if ((await this.repo.countCoupons(tenantId)) >= MAX_COUPONS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_COUPONS} codes.`);
    const code = normalizeCode(input.code);
    if (await this.repo.couponByCode(tenantId, code)) throw new AppError(409, "DUPLICATE", `The code ${code} already exists.`);
    await this.checkCouponRefs(tenantId, input.productIds, input.categoryIds, products);
    const c = await this.repo.createCoupon(tenantId, {
      code,
      kind: input.kind,
      amount: input.amount,
      minSpend: input.minSpend ?? null,
      maxUses: input.maxUses ?? null,
      maxPerCustomer: input.maxPerCustomer ?? null,
      expiresAt: input.expiresAt ?? null,
      productIds: input.productIds ?? [],
      categoryIds: input.categoryIds ?? [],
      freeShipping: input.freeShipping ?? false,
      active: input.active ?? true,
      note: input.note ?? null,
    });
    return this.couponView(c);
  }

  async updateCoupon(tenantId: string, id: string, input: z.infer<typeof couponPatch>, products: (ids: string[]) => Promise<{ id: string }[]>) {
    const cur = await this.repo.coupon(tenantId, id);
    if (!cur) throw new NotFoundError("Code not found");
    const kind = input.kind ?? cur.kind;
    const amount = input.amount ?? Number(cur.amount);
    if (kind === "PERCENT" && amount > 100) throw new AppError(400, "BAD_AMOUNT", "A percent discount can't be more than 100%");
    const data: Prisma.StoreCouponUpdateManyMutationInput = {};
    if (input.code !== undefined) {
      const code = normalizeCode(input.code);
      const other = await this.repo.couponByCode(tenantId, code);
      if (other && other.id !== id) throw new AppError(409, "DUPLICATE", `The code ${code} already exists.`);
      data.code = code;
    }
    await this.checkCouponRefs(tenantId, input.productIds, input.categoryIds, products);
    for (const k of ["kind", "amount", "minSpend", "maxUses", "maxPerCustomer", "expiresAt", "productIds", "categoryIds", "freeShipping", "active", "note"] as const) {
      if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
    }
    await this.repo.updateCoupon(tenantId, id, data);
    return this.couponView((await this.repo.coupon(tenantId, id))!);
  }

  async deleteCoupon(tenantId: string, id: string) {
    const r = await this.repo.deleteCoupon(tenantId, id);
    if (r.count === 0) throw new NotFoundError("Code not found");
  }

  // ======================= السلايدر =======================
  async banners(tenantId: string, slug: string) {
    return (await this.repo.banners(tenantId)).map((b) => ({ ...b, imageUrl: bannerUrl(slug, b.id, b.createdAt) }));
  }
  async addBanner(tenantId: string, slug: string, input: z.infer<typeof bannerInput>) {
    if ((await this.repo.countBanners(tenantId)) >= MAX_BANNERS) throw new AppError(400, "TOO_MANY", `Up to ${MAX_BANNERS} slides.`);
    await this.repo.createBanner(tenantId, { dataUrl: input.dataUrl, title: input.title ?? null, subtitle: input.subtitle ?? null, buttonText: input.buttonText ?? null, link: input.link ?? null });
    return this.banners(tenantId, slug);
  }
  async updateBanner(tenantId: string, slug: string, id: string, input: z.infer<typeof bannerPatch>) {
    const r = await this.repo.updateBanner(tenantId, id, Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
    if (r.count === 0) throw new NotFoundError("Slide not found");
    return this.banners(tenantId, slug);
  }
  async deleteBanner(tenantId: string, slug: string, id: string) {
    const r = await this.repo.deleteBanner(tenantId, id);
    if (r.count === 0) throw new NotFoundError("Slide not found");
    return this.banners(tenantId, slug);
  }
  async orderBanners(tenantId: string, slug: string, ids: string[]) {
    await this.repo.orderBanners(tenantId, ids);
    return this.banners(tenantId, slug);
  }
}
