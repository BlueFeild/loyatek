import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { prisma } from "../../config/db";
import { zodMessage } from "../../utils/validation";
import { ValidationError } from "../../core/errors";
import { categoryInput, checkoutInput, idOrderInput, ORDER_STATUSES, orderPatch, photoInput, productInput, productPatch, settingsInput } from "./store.logic";
import { StoreRepository } from "./store.repository";
import { StoreService, tooManyOrders } from "./store.service";

// المتجر الإلكتروني: الراوترات بتتأكد من البيانات (zod) وتنادي الخدمة بس - المنطق في store.service.ts
export const storeService = new StoreService(new StoreRepository(prisma));
const svc = storeService;

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
  return parsed.data;
}
const tid = (req: Request) => req.auth!.tenantId;

// ================= التاجر =================
export const storeRouter = Router();
storeRouter.use(requireAuth, requireModule("store"));
const editors = requireRole("OWNER", "ADMIN", "MANAGER");
const staff = requireRole("OWNER", "ADMIN", "MANAGER", "STAFF");

storeRouter.get("/settings", async (req, res) => res.json(await svc.getSettings(tid(req))));
storeRouter.patch("/settings", editors, async (req, res) => res.json(await svc.saveSettings(tid(req), body(settingsInput, req))));

storeRouter.get("/categories", async (req, res) => res.json(await svc.categories(tid(req))));
storeRouter.post("/categories", editors, async (req, res) => res.status(201).json(await svc.createCategory(tid(req), body(categoryInput, req).name)));
storeRouter.put("/categories/order", editors, async (req, res) => res.json(await svc.orderCategories(tid(req), body(idOrderInput, req).ids)));
storeRouter.patch("/categories/:id", editors, async (req, res) => res.json(await svc.renameCategory(tid(req), req.params.id, body(categoryInput, req).name)));
storeRouter.delete("/categories/:id", editors, async (req, res) => {
  await svc.deleteCategory(tid(req), req.params.id);
  res.status(204).end();
});

storeRouter.get("/products", async (req, res) => res.json(await svc.products(tid(req))));
storeRouter.post("/products", editors, async (req, res) => res.status(201).json(await svc.createProduct(tid(req), body(productInput, req))));
storeRouter.put("/products/order", editors, async (req, res) => {
  await svc.orderProducts(tid(req), body(idOrderInput, req).ids);
  res.status(204).end();
});
storeRouter.get("/products/:id", async (req, res) => res.json(await svc.product(tid(req), req.params.id)));
storeRouter.patch("/products/:id", editors, async (req, res) => res.json(await svc.updateProduct(tid(req), req.params.id, body(productPatch, req))));
storeRouter.delete("/products/:id", editors, async (req, res) => {
  await svc.deleteProduct(tid(req), req.params.id);
  res.status(204).end();
});
storeRouter.post("/products/:id/duplicate", editors, async (req, res) => res.status(201).json(await svc.duplicateProduct(tid(req), req.params.id)));
storeRouter.post("/products/:id/photos", editors, async (req, res) => res.status(201).json(await svc.addPhoto(tid(req), req.params.id, body(photoInput, req).dataUrl)));
storeRouter.put("/products/:id/photos/order", editors, async (req, res) => res.json(await svc.orderPhotos(tid(req), req.params.id, body(idOrderInput, req).ids)));
storeRouter.delete("/products/:id/photos/:photoId", editors, async (req, res) => res.json(await svc.deletePhoto(tid(req), req.params.id, req.params.photoId)));

storeRouter.get("/orders", async (req, res) => {
  const status = typeof req.query.status === "string" && (ORDER_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.orders(tid(req), status));
});
storeRouter.get("/orders/:id", async (req, res) => res.json(await svc.order(tid(req), req.params.id)));
storeRouter.patch("/orders/:id", staff, async (req, res) => res.json(await svc.updateOrder(tid(req), req.params.id, body(orderPatch, req))));
storeRouter.post("/orders/:id/paid", staff, async (req, res) => res.json(await svc.markPaid(tid(req), req.params.id)));

// ================= المتجر العام (من غير تسجيل دخول) =================
export const publicStoreRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendImage(req: Request, res: Response, kind: "photo" | "logo" | "cover", id?: string) {
  if (kind === "photo" && !UUID.test(id ?? "")) return res.status(404).json({ error: "Not found" });
  const img = await svc.image(req.params.slug, kind, id);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("ETag", img.etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.headers["if-none-match"] === img.etag) return res.status(304).end();
  res.type(img.mime).send(img.bytes);
}

publicStoreRouter.get("/:slug/photo/:id", (req, res) => sendImage(req, res, "photo", req.params.id));
publicStoreRouter.get("/:slug/logo", (req, res) => sendImage(req, res, "logo"));
publicStoreRouter.get("/:slug/cover", (req, res) => sendImage(req, res, "cover"));

publicStoreRouter.get("/:slug", async (req, res) => res.json(await svc.shop(req.params.slug)));
publicStoreRouter.get("/:slug/products/:id", async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: "Product not found" });
  res.json(await svc.shopProduct(req.params.slug, req.params.id));
});
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
