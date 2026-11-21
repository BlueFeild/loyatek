import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { prisma } from "../../config/db";
import { zodMessage } from "../../utils/validation";
import { AppError, ValidationError } from "../../core/errors";
import {
  attributeInput,
  attributePatch,
  bannerInput,
  bannerPatch,
  categoryInput,
  categoryPatch,
  checkoutInput,
  couponInput,
  couponPatch,
  idOrderInput,
  ORDER_STATUSES,
  orderPatch,
  photoInput,
  productInput,
  productPatch,
  quoteInput,
  settingsInput,
  tagInput,
  termInput,
  termPatch,
  variationInput,
  variationPatch,
  variationsBulkInput,
} from "./store.logic";
import { lookInput } from "./store-look.logic";
import { CSV_MAX_CHARS } from "./store-csv.logic";
import { StoreRepository } from "./store.repository";
import { StoreCatalogRepository } from "./store-catalog.repository";
import { StoreService, tooManyOrders } from "./store.service";
import { StoreCsvService } from "./store-csv.service";

// المتجر الإلكتروني: الراوترات بتتأكد من البيانات (zod) وتنادي الخدمة بس - المنطق في store.service.ts / store-catalog.service.ts
const repo = new StoreRepository(prisma);
const catalogRepo = new StoreCatalogRepository(prisma);
export const storeService = new StoreService(repo, catalogRepo);
const svc = storeService;
const cat = storeService.catalog;
const csv = new StoreCsvService(repo, catalogRepo, cat);

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
  return parsed.data;
}
const tid = (req: Request) => req.auth!.tenantId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v: string, what = "Not found") => {
  if (!UUID.test(v)) throw new AppError(404, "NOT_FOUND", what);
  return v;
};
const slugOf = async (req: Request) => (await prisma.tenant.findUnique({ where: { id: tid(req) }, select: { slug: true } }))?.slug ?? "";

// ================= التاجر =================
export const storeRouter = Router();
storeRouter.use(requireAuth, requireModule("store"));
const editors = requireRole("OWNER", "ADMIN", "MANAGER");
const staff = requireRole("OWNER", "ADMIN", "MANAGER", "STAFF");

storeRouter.get("/settings", async (req, res) => res.json(await svc.getSettings(tid(req))));
storeRouter.patch("/settings", editors, async (req, res) => res.json(await svc.saveSettings(tid(req), body(settingsInput, req))));
storeRouter.patch("/look", editors, async (req, res) => res.json(await svc.saveLook(tid(req), body(lookInput, req))));

// ---------- الأقسام ----------
storeRouter.get("/categories", async (req, res) => res.json(await cat.categories(tid(req), await slugOf(req))));
storeRouter.post("/categories", editors, async (req, res) => res.status(201).json(await cat.createCategory(tid(req), await slugOf(req), body(categoryInput, req))));
storeRouter.put("/categories/order", editors, async (req, res) => res.json(await cat.orderCategories(tid(req), await slugOf(req), body(idOrderInput, req).ids)));
storeRouter.patch("/categories/:id", editors, async (req, res) => res.json(await cat.updateCategory(tid(req), await slugOf(req), uuidParam(req.params.id, "Category not found"), body(categoryPatch, req))));
storeRouter.delete("/categories/:id", editors, async (req, res) => {
  await cat.deleteCategory(tid(req), uuidParam(req.params.id, "Category not found"));
  res.status(204).end();
});

// ---------- الخصائص + القيم ----------
storeRouter.get("/attributes", async (req, res) => res.json(await cat.attributes(tid(req), await slugOf(req))));
storeRouter.post("/attributes", editors, async (req, res) => res.status(201).json(await cat.createAttribute(tid(req), await slugOf(req), body(attributeInput, req))));
storeRouter.patch("/attributes/:id", editors, async (req, res) => res.json(await cat.updateAttribute(tid(req), await slugOf(req), uuidParam(req.params.id), body(attributePatch, req))));
storeRouter.delete("/attributes/:id", editors, async (req, res) => {
  await cat.deleteAttribute(tid(req), uuidParam(req.params.id));
  res.status(204).end();
});
storeRouter.post("/attributes/:id/terms", editors, async (req, res) => res.status(201).json(await cat.addTerm(tid(req), await slugOf(req), uuidParam(req.params.id), body(termInput, req))));
storeRouter.put("/attributes/:id/terms/order", editors, async (req, res) => res.json(await cat.orderTerms(tid(req), await slugOf(req), uuidParam(req.params.id), body(idOrderInput, req).ids)));
storeRouter.patch("/attributes/:id/terms/:termId", editors, async (req, res) => res.json(await cat.updateTerm(tid(req), await slugOf(req), uuidParam(req.params.id), uuidParam(req.params.termId), body(termPatch, req))));
storeRouter.delete("/attributes/:id/terms/:termId", editors, async (req, res) => res.json(await cat.deleteTerm(tid(req), await slugOf(req), uuidParam(req.params.id), uuidParam(req.params.termId))));

// ---------- التاجز ----------
storeRouter.get("/tags", async (req, res) => res.json(await cat.tags(tid(req))));
storeRouter.post("/tags", editors, async (req, res) => res.status(201).json(await cat.createTag(tid(req), body(tagInput, req).name)));
storeRouter.patch("/tags/:id", editors, async (req, res) => res.json(await cat.renameTag(tid(req), uuidParam(req.params.id), body(tagInput, req).name)));
storeRouter.delete("/tags/:id", editors, async (req, res) => {
  await cat.deleteTag(tid(req), uuidParam(req.params.id));
  res.status(204).end();
});

// ---------- الكوبونات ----------
const productRefs = (req: Request) => (ids: string[]) => repo.productRefs(tid(req), ids);
storeRouter.get("/coupons", editors, async (req, res) => res.json(await cat.coupons(tid(req))));
storeRouter.post("/coupons", editors, async (req, res) => res.status(201).json(await cat.createCoupon(tid(req), body(couponInput, req), productRefs(req))));
storeRouter.patch("/coupons/:id", editors, async (req, res) => res.json(await cat.updateCoupon(tid(req), uuidParam(req.params.id), body(couponPatch, req), productRefs(req))));
storeRouter.delete("/coupons/:id", editors, async (req, res) => {
  await cat.deleteCoupon(tid(req), uuidParam(req.params.id));
  res.status(204).end();
});

// ---------- السلايدر ----------
storeRouter.get("/banners", async (req, res) => res.json(await cat.banners(tid(req), await slugOf(req))));
storeRouter.post("/banners", editors, async (req, res) => res.status(201).json(await cat.addBanner(tid(req), await slugOf(req), body(bannerInput, req))));
storeRouter.put("/banners/order", editors, async (req, res) => res.json(await cat.orderBanners(tid(req), await slugOf(req), body(idOrderInput, req).ids)));
storeRouter.patch("/banners/:id", editors, async (req, res) => res.json(await cat.updateBanner(tid(req), await slugOf(req), uuidParam(req.params.id), body(bannerPatch, req))));
storeRouter.delete("/banners/:id", editors, async (req, res) => res.json(await cat.deleteBanner(tid(req), await slugOf(req), uuidParam(req.params.id))));

// ---------- CSV ----------
storeRouter.get("/products/export.csv", editors, async (req, res) => {
  const text = await csv.exportCsv(tid(req));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(text);
});
const csvParser = express.text({ type: ["text/csv", "text/plain", "application/octet-stream"], limit: "6mb" });
storeRouter.post("/products/import", editors, csvParser, async (req, res) => {
  const text = typeof req.body === "string" ? req.body : typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!text.trim()) throw new ValidationError("Choose a CSV file first.");
  if (text.length > CSV_MAX_CHARS) throw new ValidationError("The file is too big (max 5 MB).");
  res.json(await csv.importCsv(tid(req), text));
});

// ---------- المنتجات ----------
storeRouter.get("/products", async (req, res) => res.json(await svc.products(tid(req))));
storeRouter.post("/products", editors, async (req, res) => res.status(201).json(await svc.createProduct(tid(req), body(productInput, req))));
storeRouter.put("/products/order", editors, async (req, res) => {
  await svc.orderProducts(tid(req), body(idOrderInput, req).ids);
  res.status(204).end();
});
storeRouter.get("/products/:id", async (req, res) => res.json(await svc.product(tid(req), uuidParam(req.params.id, "Product not found"))));
storeRouter.patch("/products/:id", editors, async (req, res) => res.json(await svc.updateProduct(tid(req), uuidParam(req.params.id, "Product not found"), body(productPatch, req))));
storeRouter.delete("/products/:id", editors, async (req, res) => {
  await svc.deleteProduct(tid(req), uuidParam(req.params.id, "Product not found"));
  res.status(204).end();
});
storeRouter.post("/products/:id/duplicate", editors, async (req, res) => res.status(201).json(await svc.duplicateProduct(tid(req), uuidParam(req.params.id, "Product not found"))));
storeRouter.post("/products/:id/photos", editors, async (req, res) => res.status(201).json(await svc.addPhoto(tid(req), uuidParam(req.params.id, "Product not found"), body(photoInput, req).dataUrl)));
storeRouter.put("/products/:id/photos/order", editors, async (req, res) => res.json(await svc.orderPhotos(tid(req), uuidParam(req.params.id, "Product not found"), body(idOrderInput, req).ids)));
storeRouter.delete("/products/:id/photos/:photoId", editors, async (req, res) => res.json(await svc.deletePhoto(tid(req), uuidParam(req.params.id, "Product not found"), uuidParam(req.params.photoId, "Photo not found"))));
// الاختيارات
storeRouter.post("/products/:id/variations/generate", editors, async (req, res) => res.json(await svc.generateVariations(tid(req), uuidParam(req.params.id, "Product not found"))));
storeRouter.post("/products/:id/variations/bulk", editors, async (req, res) => res.json(await svc.bulkVariations(tid(req), uuidParam(req.params.id, "Product not found"), body(variationsBulkInput, req))));
storeRouter.post("/products/:id/variations", editors, async (req, res) => res.status(201).json(await svc.addVariation(tid(req), uuidParam(req.params.id, "Product not found"), body(variationInput, req))));
storeRouter.patch("/products/:id/variations/:vid", editors, async (req, res) => res.json(await svc.updateVariation(tid(req), uuidParam(req.params.id, "Product not found"), uuidParam(req.params.vid, "Choice not found"), body(variationPatch, req))));
storeRouter.delete("/products/:id/variations/:vid", editors, async (req, res) => res.json(await svc.deleteVariation(tid(req), uuidParam(req.params.id, "Product not found"), uuidParam(req.params.vid, "Choice not found"))));

// ---------- الطلبات ----------
storeRouter.get("/orders", async (req, res) => {
  const status = typeof req.query.status === "string" && (ORDER_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.orders(tid(req), status));
});
storeRouter.get("/orders/:id", async (req, res) => res.json(await svc.order(tid(req), uuidParam(req.params.id, "Order not found"))));
storeRouter.patch("/orders/:id", staff, async (req, res) => res.json(await svc.updateOrder(tid(req), uuidParam(req.params.id, "Order not found"), body(orderPatch, req))));
storeRouter.post("/orders/:id/paid", staff, async (req, res) => res.json(await svc.markPaid(tid(req), uuidParam(req.params.id, "Order not found"))));

// ================= المتجر العام (من غير تسجيل دخول) =================
export const publicStoreRouter = Router();

async function sendImage(req: Request, res: Response, kind: "photo" | "logo" | "cover" | "banner" | "category" | "term", id?: string) {
  if (id !== undefined && !UUID.test(id)) return res.status(404).json({ error: "Not found" });
  const img = await svc.image(req.params.slug, kind, id);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("ETag", img.etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.headers["if-none-match"] === img.etag) return res.status(304).end();
  res.type(img.mime).send(img.bytes);
}

publicStoreRouter.get("/:slug/photo/:id", (req, res) => sendImage(req, res, "photo", req.params.id));
publicStoreRouter.get("/:slug/banner/:id", (req, res) => sendImage(req, res, "banner", req.params.id));
publicStoreRouter.get("/:slug/category/:id/image", (req, res) => sendImage(req, res, "category", req.params.id));
publicStoreRouter.get("/:slug/term/:id/image", (req, res) => sendImage(req, res, "term", req.params.id));
publicStoreRouter.get("/:slug/logo", (req, res) => sendImage(req, res, "logo"));
publicStoreRouter.get("/:slug/cover", (req, res) => sendImage(req, res, "cover"));

publicStoreRouter.get("/:slug", async (req, res) => res.json(await svc.shop(req.params.slug)));

const listQuery = z.object({
  category: z.string().max(100).optional(),
  tag: z.string().max(100).optional(),
  terms: z.string().max(2000).optional(),
  min: z.coerce.number().finite().min(0).optional(),
  max: z.coerce.number().finite().min(0).optional(),
  inStock: z.enum(["1", "0", "true", "false"]).optional(),
  sale: z.enum(["1", "0", "true", "false"]).optional(),
  q: z.string().max(100).optional(),
  sort: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});
publicStoreRouter.get("/:slug/products", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
  const q = parsed.data;
  res.json(
    await svc.shopProducts(req.params.slug, {
      category: q.category,
      tag: q.tag,
      terms: q.terms,
      min: q.min ?? null,
      max: q.max ?? null,
      inStock: q.inStock === "1" || q.inStock === "true",
      onSale: q.sale === "1" || q.sale === "true",
      q: q.q,
      sort: q.sort,
      page: q.page,
      limit: q.limit,
    })
  );
});
publicStoreRouter.get("/:slug/products/:id", async (req, res) => {
  if (!/^[\p{L}\p{N}-]{1,100}$/u.test(req.params.id)) return res.status(404).json({ error: "Product not found" });
  res.json(await svc.shopProduct(req.params.slug, req.params.id));
});
publicStoreRouter.post("/:slug/quote", async (req, res) => res.json(await svc.quote(req.params.slug, body(quoteInput, req))));
publicStoreRouter.post("/:slug/orders", async (req, res) => {
  if (tooManyOrders(req.ip || "?")) return res.status(429).json({ error: "Too many orders from this device — please wait a few minutes.", code: "RATE_LIMITED" });
  const input = body(checkoutInput, req);
  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  res.status(201).json(await svc.placeOrder(req.params.slug, input, frontendBase));
});
publicStoreRouter.get("/:slug/orders/:id", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Order not found" });
  const paymentId = typeof req.query.paymentId === "string" ? req.query.paymentId.slice(0, 100) : undefined;
  res.json(await svc.customerOrder(req.params.slug, req.params.id, paymentId));
});
