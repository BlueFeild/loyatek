import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { container } from "../../core/container";
import { NotFoundError } from "../../core/errors";
import { zodMessage } from "../../utils/validation";
import { copyBriefSchema } from "./copy-generator";
import { AI_COSTS, AI_LIMITS } from "./ai-pricing";
import { auditInputSchema, imageBriefSchema, videoBriefSchema } from "./media-types";
import { assetEtag, planAssetResponse } from "./asset-http";

const { copywriterService, imageStudioService, videoStudioService, accountAuditService, aiAssets } = container;

// استوديو الذكاء الاصطناعي - الـ controller بيستقبل ويتأكد من البيانات بس، والمنطق في الخدمات
export const aiRouter = Router();
// خدمة بتتباع: مقفولة غير للمشترك في "ai" (أو التجربة / شركة المنصة)
aiRouter.use(requireAuth, requireModule("ai"));

// اللي بيصرف نقاط (يولّد) = المالك / الأدمن / المدير بس. الفرجة على النتايج للكل
const canSpend = requireRole("OWNER", "ADMIN", "MANAGER");

// الأدوات المتاحة وسعر كل واحدة (الشاشة بتقرا من هنا)
aiRouter.get("/tools", (_req, res) => {
  res.json({
    copy: { available: copywriterService.isAvailable, cost: AI_COSTS.copy },
    image: { available: imageStudioService.isAvailable, cost: AI_COSTS.image },
    video: { available: videoStudioService.isAvailable, cost: AI_COSTS.video, pollMs: AI_LIMITS.videoPollMs },
    audit: { available: accountAuditService.isAvailable, cost: AI_COSTS.audit },
  });
});

// ---------- الكاتب الذكي ----------
aiRouter.get("/copywriter", async (req, res) => {
  res.json({ available: copywriterService.isAvailable, cost: AI_COSTS.copy, history: await copywriterService.history(req.auth!.tenantId) });
});

aiRouter.post("/copywriter", canSpend, async (req, res) => {
  const parsed = copyBriefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await copywriterService.write(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- صانع الصور ----------
aiRouter.get("/images", async (req, res) => {
  res.json(await imageStudioService.history(req.auth!.tenantId));
});

aiRouter.post("/images", canSpend, async (req, res) => {
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

aiRouter.post("/videos", canSpend, async (req, res) => {
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

aiRouter.post("/audits", canSpend, async (req, res) => {
  const parsed = auditInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await accountAuditService.run(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

// ---------- ملفات الصور والفيديو (لنفس الشركة بس) ----------
// الملفات مابتتغيرش: ETag + كاش سنة، 304 لو المتصفح عنده نفس النسخة،
// و Range (206) بيقرا الجزء المطلوب بس من قاعدة البيانات (تقديم الفيديو من غير تحميله كله)
aiRouter.get("/assets/:id", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const meta = await aiAssets.meta(tenantId, req.params.id);
  if (!meta) throw new NotFoundError("File not found");
  const etag = assetEtag(meta);
  const ext = meta.kind === "video" ? "mp4" : meta.mimeType.split("/")[1] || "png";
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const plan = planAssetResponse({ size: meta.size, etag, ifNoneMatch: req.header("if-none-match"), range: req.header("range") });
  if (plan.status === 304) return res.status(304).end();
  if (plan.status === 416) {
    res.setHeader("Content-Range", `bytes */${meta.size}`);
    return res.status(416).end();
  }
  res.setHeader("Content-Type", meta.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="bluefield-ai-${meta.id.slice(0, 8)}.${ext}"`);
  if (plan.status === 206) {
    const chunk = await aiAssets.slice(tenantId, meta.id, plan.start, plan.end - plan.start + 1);
    if (!chunk) throw new NotFoundError("File not found");
    res.setHeader("Content-Range", `bytes ${plan.start}-${plan.start + chunk.length - 1}/${meta.size}`);
    res.setHeader("Content-Length", String(chunk.length));
    return res.status(206).end(chunk);
  }
  const asset = await aiAssets.get(tenantId, meta.id);
  if (!asset) throw new NotFoundError("File not found");
  res.setHeader("Content-Length", String(asset.data.length));
  res.end(asset.data);
});
