import { Router, type Request, type Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { AppError } from "../../core/errors";
import { WebsiteService, type ImageBytes } from "./website.service";
import { clientIp } from "../../utils/visitor-country";
import { contentSchema, inquiryStatusSchema, photoSchema, publicInquirySchema, settingsSchema } from "./website.schemas";

// الموقع التعريفي (module "website") - الراوترات بس: تحقق من المدخلات وبعدين الخدمة
export const websiteRouter = Router();
export const publicWebsiteRouter = Router();

const service = new WebsiteService();
const writers = requireRole("OWNER", "ADMIN", "MANAGER");
const uuid = z.string().uuid();

// أول غلطة بجملة مفهومة
function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const msg = issue?.code === "unrecognized_keys" ? "Some fields aren't allowed here." : issue?.message || "Please check the form and try again.";
  throw new AppError(400, "VALIDATION_ERROR", msg);
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

// حد بسيط لكل IP (يمنع سبام بسكربت)
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length > max;
  };
}
const tooManyMessages = limiter(Number(process.env.WEBSITE_INQUIRY_LIMIT) || 10, 10 * 60_000);
const tooManyVisits = limiter(60, 10 * 60_000);

// ================= لوحة التاجر =================
websiteRouter.use(requireAuth, requireModule("website"));

websiteRouter.get("/", async (req, res) => {
  res.json(await service.overview(req.auth!.tenantId));
});
websiteRouter.patch("/settings", writers, async (req, res) => {
  res.json(await service.updateSettings(req.auth!.tenantId, parse(settingsSchema, req.body)));
});
websiteRouter.put("/content", writers, async (req, res) => {
  const body = parse(z.object({ content: z.unknown() }).strict(), req.body);
  res.json(await service.saveContent(req.auth!.tenantId, parse(contentSchema, body.content)));
});

websiteRouter.post("/photos", writers, async (req, res) => {
  const { kind, dataUrl } = parse(photoSchema, req.body);
  res.status(201).json(await service.addPhoto(req.auth!.tenantId, kind, dataUrl));
});
websiteRouter.delete("/photos/:id", writers, async (req, res) => {
  await service.deletePhoto(req.auth!.tenantId, id(req));
  res.json({ ok: true });
});
// معاينة الصورة للتاجر (حتى لو الموقع مش منشور) - الواجهة بتجيبها كـ blob بالتوكن
websiteRouter.get("/photos/:id", async (req, res) => {
  sendImage(req, res, await service.photoBytes(req.auth!.tenantId, id(req)), "private, max-age=3600");
});

websiteRouter.get("/inquiries", async (req, res) => {
  res.json(await service.listInquiries(req.auth!.tenantId));
});
websiteRouter.patch("/inquiries/:id", writers, async (req, res) => {
  const { status } = parse(inquiryStatusSchema, req.body);
  await service.setInquiryStatus(req.auth!.tenantId, id(req), status);
  res.json({ ok: true, status });
});
websiteRouter.delete("/inquiries/:id", writers, async (req, res) => {
  await service.deleteInquiry(req.auth!.tenantId, id(req));
  res.json({ ok: true });
});

// ================= الصفحة العامة =================
publicWebsiteRouter.get("/:slug", async (req, res) => {
  res.json(await service.publicSite(req.params.slug));
});
publicWebsiteRouter.get("/:slug/photos/:id", async (req, res) => {
  sendImage(req, res, await service.publicPhoto(req.params.slug, id(req)));
});
publicWebsiteRouter.get("/:slug/logo", async (req, res) => {
  sendImage(req, res, await service.publicBrandImage(req.params.slug, "logo"));
});
publicWebsiteRouter.get("/:slug/cover", async (req, res) => {
  sendImage(req, res, await service.publicBrandImage(req.params.slug, "cover"));
});
publicWebsiteRouter.post("/:slug/inquiries", async (req, res) => {
  if (tooManyMessages(clientIp(req))) return res.status(429).json({ error: "Too many messages — please wait a few minutes.", code: "RATE_LIMITED" });
  const input = parse(publicInquirySchema, req.body);
  // فخ الروبوتات: الخانة دي مخفية عن الناس، لو اتملت نرد "تمام" ومانحفظش حاجة
  if (input.website && input.website.trim()) return res.status(201).json({ ok: true });
  await service.createInquiry(req.params.slug, input);
  res.status(201).json({ ok: true });
});
// زيارة: المتصفح بيعدّها مرة في اليوم بس؛ السيرفر بيزوّد العداد
publicWebsiteRouter.post("/:slug/visit", async (req, res) => {
  if (tooManyVisits(clientIp(req))) return res.status(204).end();
  await service.addVisit(req.params.slug);
  res.status(204).end();
});
