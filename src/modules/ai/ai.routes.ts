import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { container } from "../../core/container";
import { NotFoundError } from "../../core/errors";
import { zodMessage } from "../../utils/validation";
import { copyBriefSchema } from "./copy-generator";
import { AI_COSTS } from "./ai-pricing";
import { auditInputSchema, imageBriefSchema, videoBriefSchema } from "./media-types";

const { copywriterService, imageStudioService, videoStudioService, accountAuditService, aiAssets } = container;

// استوديو الذكاء الاصطناعي - الـ controller بيستقبل ويتأكد من البيانات بس، والمنطق في الخدمات
export const aiRouter = Router();
aiRouter.use(requireAuth);

// الأدوات المتاحة وسعر كل واحدة (الشاشة بتقرا من هنا)
aiRouter.get("/tools", (_req, res) => {
  res.json({
    copy: { available: copywriterService.isAvailable, cost: AI_COSTS.copy },
    image: { available: imageStudioService.isAvailable, cost: AI_COSTS.image },
    video: { available: videoStudioService.isAvailable, cost: AI_COSTS.video },
    audit: { available: accountAuditService.isAvailable, cost: AI_COSTS.audit },
  });
});

// ---------- الكاتب الذكي ----------
aiRouter.get("/copywriter", async (req, res) => {
  res.json({ available: copywriterService.isAvailable, cost: AI_COSTS.copy, history: await copywriterService.history(req.auth!.tenantId) });
});

aiRouter.post("/copywriter", async (req, res) => {
  const parsed = copyBriefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await copywriterService.write(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- صانع الصور ----------
aiRouter.get("/images", async (req, res) => {
  res.json(await imageStudioService.history(req.auth!.tenantId));
});

aiRouter.post("/images", async (req, res) => {
  const parsed = imageBriefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await imageStudioService.create(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- صانع الفيديو (بيشتغل في الخلفية) ----------
aiRouter.get("/videos", async (req, res) => {
  res.json(await videoStudioService.history(req.auth!.tenantId));
});

aiRouter.get("/videos/:id", async (req, res) => {
  res.json(await videoStudioService.get(req.auth!.tenantId, req.params.id));
});

aiRouter.post("/videos", async (req, res) => {
  const parsed = videoBriefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(202).json(await videoStudioService.start(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- تحليل الحسابات ----------
aiRouter.get("/audits", async (req, res) => {
  res.json(await accountAuditService.history(req.auth!.tenantId));
});

aiRouter.get("/audits/:id", async (req, res) => {
  res.json(await accountAuditService.get(req.auth!.tenantId, req.params.id));
});

aiRouter.post("/audits", async (req, res) => {
  const parsed = auditInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await accountAuditService.run(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- ملفات الصور والفيديو (لنفس الشركة بس) ----------
aiRouter.get("/assets/:id", async (req, res) => {
  const asset = await aiAssets.get(req.auth!.tenantId, req.params.id);
  if (!asset) throw new NotFoundError("File not found");
  const ext = asset.kind === "video" ? "mp4" : asset.mimeType.split("/")[1] || "png";
  res.setHeader("Content-Type", asset.mimeType);
  res.setHeader("Content-Length", String(asset.data.length));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Content-Disposition", `inline; filename="bluefield-ai-${asset.id.slice(0, 8)}.${ext}"`);
  res.end(asset.data);
});
