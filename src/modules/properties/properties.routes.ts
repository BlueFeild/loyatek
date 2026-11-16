import { Router, type Request, type Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { AppError } from "../../core/errors";
import { PropertiesService, type ImageBytes } from "./properties.service";
import {
  createListingSchema,
  inquiryStatusSchema,
  photoOrderSchema,
  photoSchema,
  publicInquirySchema,
  settingsSchema,
  updateListingSchema,
} from "./properties.schemas";

// كتالوج العقارات (module "properties") - الراوترات بس: تحقق من المدخلات وبعدين الخدمة
export const propertiesRouter = Router();
export const publicPropertiesRouter = Router();

const service = new PropertiesService();
const writers = requireRole("OWNER", "ADMIN", "MANAGER");
const uuid = z.string().uuid();

// أول غلطة بجملة مفهومة (اسم الخانة + الرسالة)
function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = issue?.path.find((p) => typeof p === "string") as string | undefined;
  const label = field ? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) : "";
  const msg = issue?.code === "unrecognized_keys" ? "Some fields aren't allowed here." : issue?.message || "Please check the form and try again.";
  throw new AppError(400, "VALIDATION_ERROR", label && !/^(Please|The|Up to|Each|Some)/.test(msg) ? `${label}: ${msg}` : msg);
}
function id(req: Request, key = "id") {
  const v = req.params[key];
  if (!uuid.safeParse(v).success) throw new AppError(404, "NOT_FOUND", "Not found");
  return v;
}

function sendImage(req: Request, res: Response, img: ImageBytes | null, cache = "public, max-age=86400") {
  if (!img) return res.status(404).json({ error: "Image not found" });
  res.setHeader("ETag", img.etag);
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.headers["if-none-match"] === img.etag) return res.status(304).end();
  res.setHeader("Content-Type", img.mime);
  res.send(img.bytes);
}

// ================= لوحة التاجر =================
propertiesRouter.use(requireAuth, requireModule("properties"));

propertiesRouter.get("/settings", async (req, res) => {
  res.json(await service.getSettings(req.auth!.tenantId));
});
propertiesRouter.patch("/settings", writers, async (req, res) => {
  res.json(await service.updateSettings(req.auth!.tenantId, parse(settingsSchema, req.body)));
});

propertiesRouter.get("/listings", async (req, res) => {
  res.json(await service.listListings(req.auth!.tenantId));
});
propertiesRouter.post("/listings", writers, async (req, res) => {
  res.status(201).json(await service.createListing(req.auth!.tenantId, parse(createListingSchema, req.body)));
});
propertiesRouter.get("/listings/:id", async (req, res) => {
  res.json(await service.getListing(req.auth!.tenantId, id(req)));
});
propertiesRouter.patch("/listings/:id", writers, async (req, res) => {
  res.json(await service.updateListing(req.auth!.tenantId, id(req), parse(updateListingSchema, req.body)));
});
propertiesRouter.delete("/listings/:id", writers, async (req, res) => {
  await service.deleteListing(req.auth!.tenantId, id(req));
  res.json({ ok: true });
});
propertiesRouter.post("/listings/:id/duplicate", writers, async (req, res) => {
  res.status(201).json(await service.duplicateListing(req.auth!.tenantId, id(req)));
});

propertiesRouter.post("/listings/:id/photos", writers, async (req, res) => {
  const { dataUrl } = parse(photoSchema, req.body);
  res.status(201).json(await service.addPhoto(req.auth!.tenantId, id(req), dataUrl));
});
propertiesRouter.delete("/listings/:id/photos/:photoId", writers, async (req, res) => {
  res.json(await service.deletePhoto(req.auth!.tenantId, id(req), id(req, "photoId")));
});
propertiesRouter.put("/listings/:id/photos/order", writers, async (req, res) => {
  const { ids } = parse(photoOrderSchema, req.body);
  res.json(await service.reorderPhotos(req.auth!.tenantId, id(req), ids));
});
// معاينة الصورة للتاجر (حتى لو العقار مخفي) - الواجهة بتجيبها كـ blob بالتوكن
propertiesRouter.get("/photos/:photoId", async (req, res) => {
  const img = await service.photoBytes(req.auth!.tenantId, id(req, "photoId"), false);
  sendImage(req, res, img, "private, max-age=3600");
});

propertiesRouter.get("/inquiries", async (req, res) => {
  res.json(await service.listInquiries(req.auth!.tenantId));
});
propertiesRouter.patch("/inquiries/:id", writers, async (req, res) => {
  const { status } = parse(inquiryStatusSchema, req.body);
  await service.setInquiryStatus(req.auth!.tenantId, id(req), status);
  res.json({ ok: true, status });
});

// ================= الصفحة العامة =================
// استفسارات لكل IP في 10 دقايق (يمنع سبام بسكربت)
const INQUIRY_LIMIT = Number(process.env.PROPERTY_INQUIRY_LIMIT) || 10;
const inquiryHits = new Map<string, number[]>();
function tooManyInquiries(ip: string) {
  const now = Date.now();
  const list = (inquiryHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  inquiryHits.set(ip, list);
  if (inquiryHits.size > 5000) inquiryHits.clear();
  return list.length > INQUIRY_LIMIT;
}

publicPropertiesRouter.get("/:slug", async (req, res) => {
  res.json(await service.publicPage(req.params.slug));
});
publicPropertiesRouter.get("/:slug/listings/:id", async (req, res) => {
  res.json(await service.publicListing(req.params.slug, id(req)));
});
publicPropertiesRouter.get("/:slug/photos/:photoId", async (req, res) => {
  sendImage(req, res, await service.publicPhoto(req.params.slug, id(req, "photoId")));
});
publicPropertiesRouter.get("/:slug/logo", async (req, res) => {
  sendImage(req, res, await service.publicBrandImage(req.params.slug, "logo"));
});
publicPropertiesRouter.get("/:slug/cover", async (req, res) => {
  sendImage(req, res, await service.publicBrandImage(req.params.slug, "cover"));
});
publicPropertiesRouter.post("/:slug/inquiries", async (req, res) => {
  if (tooManyInquiries(req.ip || "?")) return res.status(429).json({ error: "Too many messages — please wait a few minutes.", code: "RATE_LIMITED" });
  const input = parse(publicInquirySchema, req.body);
  // فخ الروبوتات: الخانة دي مخفية عن الناس، لو اتملت نرد "تمام" ومانحفظش حاجة
  if (input.website && input.website.trim()) return res.status(201).json({ ok: true });
  await service.createInquiry(req.params.slug, input);
  res.status(201).json({ ok: true });
});
