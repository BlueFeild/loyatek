import express, { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { container } from "../../core/container";
import { NotFoundError } from "../../core/errors";
import { zodMessage } from "../../utils/validation";
import { assetEtag, planAssetResponse } from "../ai/asset-http";
import { connectMetaSchema, listPostsSchema, postInputSchema, uploadMediaSchema } from "./social.schemas";
import { SOCIAL_LIMITS } from "./social-types";

const { socialAccountService, socialPostService } = container;

// النشر على السوشيال (جزء من استوديو الذكاء الاصطناعي) - الـ controller بيتأكد من البيانات بس
export const socialRouter = Router();
socialRouter.use(requireAuth, requireModule("ai"));

const canPost = requireRole("OWNER", "ADMIN", "MANAGER");
const canConnect = requireRole("OWNER", "ADMIN");

// ---------- الحسابات ----------
socialRouter.get("/config", (_req, res) => {
  res.json(socialAccountService.config());
});

socialRouter.get("/accounts", async (req, res) => {
  res.json(await socialAccountService.list(req.auth!.tenantId));
});

socialRouter.post("/accounts/meta/connect", canConnect, async (req, res) => {
  const parsed = connectMetaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialAccountService.connectMeta(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

socialRouter.delete("/accounts/:id", canConnect, async (req, res) => {
  res.json(await socialAccountService.disconnect(req.auth!.tenantId, req.params.id));
});

// ---------- الصور والفيديو (رفع خام) ----------
const rawMedia = express.raw({ type: "application/octet-stream", limit: `${Math.ceil(SOCIAL_LIMITS.videoMaxBytes / 1024 / 1024) + 1}mb` });
socialRouter.post("/media", canPost, rawMedia, async (req, res) => {
  const parsed = uploadMediaSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Missing the file type" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Send the file as application/octet-stream" });
  res.json(await socialPostService.uploadMedia(req.auth!.tenantId, parsed.data.mimeType, req.body));
});

// ---------- البوستات ----------
socialRouter.get("/posts", async (req, res) => {
  const parsed = listPostsSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialPostService.list(req.auth!.tenantId, parsed.data));
});

socialRouter.get("/posts/:id", async (req, res) => {
  res.json(await socialPostService.get(req.auth!.tenantId, req.params.id));
});

socialRouter.post("/posts", canPost, async (req, res) => {
  const parsed = postInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await socialPostService.create(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

socialRouter.put("/posts/:id", canPost, async (req, res) => {
  const parsed = postInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialPostService.update(req.auth!.tenantId, req.params.id, parsed.data));
});

socialRouter.post("/posts/:id/retry", canPost, async (req, res) => {
  res.json(await socialPostService.retry(req.auth!.tenantId, req.params.id));
});

socialRouter.delete("/posts/:id", canPost, async (req, res) => {
  res.json(await socialPostService.remove(req.auth!.tenantId, req.params.id));
});

// ---------- لينك عام للملف (فيسبوك/انستجرام بيجيبوه من هنا وقت النشر) ----------
// المفتاح 48 حرف عشوائي - مفيش طريقة تخمّنه أو توصل لملفات شركة تانية
export const publicSocialMediaRouter = Router();
publicSocialMediaRouter.get("/:key", async (req, res) => {
  const m = await socialPostService.mediaByKey(req.params.key);
  if (!m) throw new NotFoundError("File not found");
  const etag = assetEtag(m);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const plan = planAssetResponse({ size: m.size, etag, ifNoneMatch: req.header("if-none-match"), range: req.header("range") });
  if (plan.status === 304) return res.status(304).end();
  if (plan.status === 416) {
    res.setHeader("Content-Range", `bytes */${m.size}`);
    return res.status(416).end();
  }
  res.setHeader("Content-Type", m.mimeType);
  if (plan.status === 206) {
    const chunk = m.data.subarray(plan.start, plan.end + 1);
    res.setHeader("Content-Range", `bytes ${plan.start}-${plan.end}/${m.size}`);
    res.setHeader("Content-Length", String(chunk.length));
    return res.status(206).end(chunk);
  }
  res.setHeader("Content-Length", String(m.data.length));
  res.end(m.data);
});
