import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { container } from "../../core/container";
import { hasModuleAccess } from "../../middleware/module-access";
import { getEffectiveModules } from "../../utils/modules";
import { tenantGraceDays } from "../../utils/platform-config";
import { zodMessage } from "../../utils/validation";
import { postInputSchema } from "../social/social.schemas";
import { SOCIAL_LIMITS, SOCIAL_MEDIA_TYPES } from "../social/social-types";
import { assertSafeUrl } from "./webhook-signing";

// الـ API العام للبرامج الخارجية (Make / Zapier / سيستم التاجر): Authorization: Bearer bf_live_...
// كل طلب بشركة صاحب المفتاح بس، وكل جزء محتاج اشتراكه (زي اللوحة بالظبط)
export const publicApiRouter = Router();

declare global {
  namespace Express {
    interface Request {
      apiKey?: { tenantId: string; keyId: string };
    }
  }
}

// حد بسيط: 120 طلب في الدقيقة لكل مفتاح
const RATE = { windowMs: 60_000, max: 120 };
const hits = new Map<string, { start: number; n: number }>();

async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const auth = key ? await container.integrationsService.authenticate(key) : null;
  if (!auth) return res.status(401).json({ error: "Missing or invalid API key", code: "INVALID_API_KEY" });
  const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId }, select: { accountStatus: true, isPlatformOwner: true } });
  if (!tenant || (!tenant.isPlatformOwner && tenant.accountStatus !== "ACTIVE")) return res.status(403).json({ error: "This company account is not active", code: "ACCOUNT_INACTIVE" });
  const now = Date.now();
  const h = hits.get(auth.keyId);
  if (!h || now - h.start > RATE.windowMs) hits.set(auth.keyId, { start: now, n: 1 });
  else if (++h.n > RATE.max) {
    res.setHeader("Retry-After", String(Math.ceil((h.start + RATE.windowMs - now) / 1000)));
    return res.status(429).json({ error: "Too many requests — max 120 per minute", code: "RATE_LIMITED" });
  }
  if (hits.size > 10_000) hits.clear();
  req.apiKey = auth;
  next();
}

function needModule(moduleId: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await hasModuleAccess(req.apiKey!.tenantId, moduleId)) return next();
    res.status(403).json({ error: `Your ${moduleId.toUpperCase()} subscription is not active.`, code: "MODULE_INACTIVE", module: moduleId });
  };
}

publicApiRouter.use(requireApiKey);

publicApiRouter.get("/me", async (req, res) => {
  const t = await prisma.tenant.findUnique({
    where: { id: req.apiKey!.tenantId },
    select: { id: true, name: true, displayCurrency: true, subscribedModules: true, moduleExpirations: true, trialExpiresAt: true, isPlatformOwner: true, accountStatus: true, graceDays: true },
  });
  res.json({ company: { id: t!.id, name: t!.name, currency: t!.displayCurrency }, modules: getEffectiveModules(t!, new Date(), await tenantGraceDays(t!)) });
});

// ---------- السوشيال ----------
publicApiRouter.get("/social/accounts", needModule("social"), async (req, res) => {
  const list = await container.socialAccountService.list(req.apiKey!.tenantId);
  res.json(list.map((a) => ({ id: a.id, platform: a.platform, name: a.name, username: a.username, status: a.status })));
});

const listSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
publicApiRouter.get("/social/posts", needModule("social"), async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await container.socialPostService.list(req.apiKey!.tenantId, parsed.data));
});

// الصورة/الفيديو من لينك (Make / Zapier بيدّوا لينك الملف)
async function downloadMedia(url: string): Promise<{ mimeType: string; data: Buffer }> {
  const safe = await assertSafeUrl(url);
  const res = await fetch(safe, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Couldn't download the file (${res.status})`);
  const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const kind = SOCIAL_MEDIA_TYPES[mimeType];
  if (!kind) throw new Error("The file must be a JPG or PNG photo, or an MP4 / MOV video");
  const max = kind === "image" ? SOCIAL_LIMITS.imageMaxBytes : SOCIAL_LIMITS.videoMaxBytes;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) throw new Error(`The file is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw new Error(`The file is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
    chunks.push(Buffer.from(chunk));
  }
  return { mimeType, data: Buffer.concat(chunks) };
}

const apiPostSchema = z.object({ mediaUrl: z.string().url().max(2000).optional() }).passthrough();
publicApiRouter.post("/social/posts", needModule("social"), async (req, res) => {
  const extra = apiPostSchema.safeParse(req.body ?? {});
  if (!extra.success) return res.status(400).json({ error: zodMessage(extra.error) });
  let mediaId: string | null = (req.body?.mediaId as string | undefined) ?? null;
  if (extra.data.mediaUrl) {
    try {
      const file = await downloadMedia(extra.data.mediaUrl);
      mediaId = (await container.socialPostService.uploadMedia(req.apiKey!.tenantId, file.mimeType, file.data)).id;
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  }
  const { mediaUrl: _ignored, ...rest } = req.body ?? {};
  const parsed = postInputSchema.safeParse({ ...rest, mediaId });
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await container.socialPostService.create(req.apiKey!.tenantId, null, parsed.data));
});

// ---------- الحجوزات ----------
const bookingQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
publicApiRouter.get("/bookings", needModule("booking"), async (req, res) => {
  const parsed = bookingQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Use from / to like 2026-11-01" });
  const date = parsed.data.from || parsed.data.to ? { ...(parsed.data.from ? { gte: new Date(`${parsed.data.from}T00:00:00Z`) } : {}), ...(parsed.data.to ? { lte: new Date(`${parsed.data.to}T00:00:00Z`) } : {}) } : undefined;
  const rows = await prisma.booking.findMany({
    where: { tenantId: req.apiKey!.tenantId, ...(date ? { date } : {}) },
    select: { id: true, status: true, date: true, hour: true, services: true, customerName: true, customerPhone: true, customerEmail: true, branchId: true, resourceId: true, paymentStatus: true, paymentMethodLabel: true, amount: true, note: true, createdAt: true, resource: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { hour: "desc" }],
    take: 500,
  });
  res.json(rows.map((b) => ({ ...b, date: b.date.toISOString().slice(0, 10), amountUsd: b.amount === null ? null : Number(b.amount), amount: undefined, resource: b.resource?.name ?? null })));
});

// ---------- جهات اتصال واتساب ----------
publicApiRouter.get("/whatsapp/contacts", needModule("whatsapp"), async (req, res) => {
  const q = z.object({ q: z.string().max(100).optional(), tag: z.string().max(40).optional(), page: z.coerce.number().int().min(1).max(10_000).optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: zodMessage(q.error) });
  res.json(await container.contactBookService.list(req.apiKey!.tenantId, q.data));
});

const contactSchema = z.object({ phone: z.string().trim().min(6).max(30), name: z.string().trim().max(120).nullable().optional(), tags: z.array(z.string().max(40)).max(20).optional() });
publicApiRouter.post("/whatsapp/contacts", needModule("whatsapp"), async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await container.contactBookService.create(req.apiKey!.tenantId, parsed.data));
});
