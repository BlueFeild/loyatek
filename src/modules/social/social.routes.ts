import express, { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { container } from "../../core/container";
import { NotFoundError } from "../../core/errors";
import { zodMessage } from "../../utils/validation";
import { assetEtag, planAssetResponse } from "../ai/asset-http";
import { connectMetaSchema, listPostsSchema, postInputSchema, replySchema, suggestSchema, threadListSchema, threadRefSchema, uploadMediaSchema } from "./social.schemas";
import { verifyMetaSignature } from "../whatsapp/webhook";
import { SOCIAL_LIMITS } from "./social-types";
import { adsRouter } from "./ads.routes";

const { socialAccountService, socialPostService, socialInboxService } = container;

// النشر على السوشيال (جزء من استوديو الذكاء الاصطناعي) - الـ controller بيتأكد من البيانات بس
export const socialRouter = Router();
socialRouter.use(requireAuth, requireModule("ai"));

const canPost = requireRole("OWNER", "ADMIN", "MANAGER");
const canConnect = requireRole("OWNER", "ADMIN");

// ---------- الإعلانات المدفوعة (تمويل بوست) ----------
socialRouter.use("/ads", adsRouter);

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
  // توثيق اللينك عند تيك توك (URL prefix): ملف tiktokXXXX.txt اسمه ومحتواه من Railway Variables
  const verifyName = process.env.TIKTOK_VERIFICATION_FILE_NAME?.trim();
  if (verifyName && req.params.key === verifyName) {
    return res.type("text/plain").send(process.env.TIKTOK_VERIFICATION_FILE_CONTENT?.trim() ?? "");
  }
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

// ---------- صندوق التعليقات والرسايل ----------
socialRouter.get("/inbox/threads", async (req, res) => {
  const parsed = threadListSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json({ threads: await socialInboxService.threads(req.auth!.tenantId, parsed.data), canSuggest: socialInboxService.canSuggest });
});

socialRouter.get("/inbox/unread", async (req, res) => {
  res.json({ unread: await socialInboxService.unreadCount(req.auth!.tenantId) });
});

socialRouter.get("/inbox/thread", async (req, res) => {
  const parsed = threadRefSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialInboxService.thread(req.auth!.tenantId, parsed.data));
});

socialRouter.post("/inbox/sync", canPost, async (req, res) => {
  res.json(await socialInboxService.sync(req.auth!.tenantId));
});

socialRouter.post("/inbox/reply", canPost, async (req, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  const { text, ...ref } = parsed.data;
  res.json(await socialInboxService.reply(req.auth!.tenantId, req.auth!.userId, ref, text));
});

socialRouter.post("/inbox/suggest", canPost, async (req, res) => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  const { dialect, ...ref } = parsed.data;
  res.json(await socialInboxService.suggest(req.auth!.tenantId, req.auth!.userId, ref, dialect));
});

// ---------- Webhook المنصة لفيسبوك/انستجرام (object = page / instagram) ----------
// نفس تطبيق Meta: Verify Token = META_WEBHOOK_VERIFY_TOKEN، والتوقيع بـ META_APP_SECRET
export const publicSocialWebhookRouter = Router();

publicSocialWebhookRouter.get("/", (req, res) => {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!expected || req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== expected) return res.status(403).send("Forbidden");
  res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
});

publicSocialWebhookRouter.post("/", async (req: express.Request & { rawBody?: Buffer }, res) => {
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret || !verifyMetaSignature(req.rawBody, req.header("x-hub-signature-256"), secret)) {
    console.warn(`[social-webhook] rejected: ${!secret ? "META_APP_SECRET is not set" : "signature mismatch (check META_APP_SECRET)"}`);
    return res.sendStatus(401);
  }
  // نرد على Meta على طول (لازم في ثواني) وبعدين نسجّل
  res.sendStatus(200);
  try {
    await socialInboxService.handleWebhook(req.body);
  } catch (err) {
    console.warn(`[social-webhook] processing failed: ${(err as Error)?.message}`);
  }
});

// ---------- تيك توك ----------
// لينك دخول تيك توك (التاجر بيتنقل له، وتيك توك بيرجعه على الـ callback العام)
socialRouter.get("/tiktok/connect-url", canConnect, (req, res) => {
  res.json(socialAccountService.tiktokConnectUrl(req.auth!.tenantId, req.auth!.userId));
});

socialRouter.get("/tiktok/creator-info", async (req, res) => {
  const accountId = String(req.query.accountId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return res.status(400).json({ error: "Missing the TikTok account" });
  res.json(await socialAccountService.tiktokCreatorInfo(req.auth!.tenantId, accountId));
});

export const publicTikTokCallbackRouter = Router();
publicTikTokCallbackRouter.get("/", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  res.redirect(302, await socialAccountService.tiktokCallback({ code: q.code, state: q.state, error: q.error, error_description: q.error_description }));
});
