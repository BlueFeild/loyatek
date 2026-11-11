import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { isModuleLive } from "../../utils/platform-config";
import { container } from "../../core/container";
import { getOrCreateWhatsappSettings } from "../whatsapp/whatsapp.service";
import { loginTemplateStatus, submitLoginTemplate } from "./wa-login.gateway";

// ---------- التاجر (جوه السيستم) ----------
export const waLoginRouter = Router();
waLoginRouter.use(requireAuth, requireModule("walogin"));

const ORIGIN = z.string().trim().toLowerCase().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/, "Write the website like https://www.example.com (no path)");
const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireOnBooking: z.boolean().optional(),
    siteOrigins: z.array(ORIGIN).max(10).optional(),
    templateLang: z.enum(["en", "ar"]).optional(),
  })
  .strict();

waLoginRouter.get("/", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [settings, wa, tenant] = await Promise.all([
    container.waLoginStore.settings(tenantId),
    getOrCreateWhatsappSettings(tenantId),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  ]);
  const template = await loginTemplateStatus(tenantId, settings.templateLang);
  const usage = await container.waLoginStore.usage(tenantId, new Date(Date.now() - 30 * 24 * 3600 * 1000));
  res.json({ settings, whatsappConnected: Boolean(wa.isConnected), whatsappNumber: wa.displayPhoneNumber ?? null, template, usage, slug: tenant?.slug ?? "" });
});

waLoginRouter.patch("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });
  const data = { ...parsed.data, ...(parsed.data.siteOrigins ? { siteOrigins: Array.from(new Set(parsed.data.siteOrigins)) } : {}) };
  res.json(await container.waLoginStore.saveSettings(req.auth!.tenantId, data));
});

waLoginRouter.post("/template", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const settings = await container.waLoginStore.settings(req.auth!.tenantId);
  try {
    res.json(await submitLoginTemplate(req.auth!.tenantId, settings.templateLang));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Couldn't send the template to Meta" });
  }
});

// كود تجريبي على رقم التاجر نفسه (بيشتغل حتى لو الخدمة لسه مقفولة)
waLoginRouter.post("/test", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const phone = String(req.body?.phone ?? "");
  res.json(await container.waLogin.start({ tenantId: req.auth!.tenantId, phone, ip: clientIp(req), source: "test" }));
});

// ---------- العامة (صفحة الحجز + موقع التاجر) ----------
export const publicWaLoginRouter = Router({ mergeParams: true });

function clientIp(req: Request): string | null {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return (fwd || req.ip || "").slice(0, 64) || null;
}

const ownOrigins = () =>
  [
    "http://localhost:5173",
    "http://localhost:4173",
    ...(process.env.ALLOWED_ORIGINS ?? "").split(","),
    process.env.FRONTEND_BASE_URL ?? "",
  ]
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

async function liveTenant(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant || !(await isModuleLive(tenant, "walogin"))) return null;
  return tenant;
}

// CORS خاص: مواقعنا + المواقع اللي التاجر كتبها بنفسه بس (عشان محدش يبعت أكواد على حسابه من أي موقع)
publicWaLoginRouter.use("/:slug", async (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    let allowed = ownOrigins().includes(origin);
    if (!allowed) {
      const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
      if (tenant) allowed = (await container.waLoginStore.settings(tenant.id)).siteOrigins.includes(origin.toLowerCase());
    }
    if (!allowed) return res.status(403).json({ error: "This website isn't allowed to use WhatsApp login for this business." });
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const startSchema = z.object({ phone: z.string().min(6).max(32), source: z.enum(["booking", "site"]).optional() });
const verifySchema = z.object({ phone: z.string().min(6).max(32), code: z.string().min(4).max(12) });

publicWaLoginRouter.post("/:slug/start", async (req, res) => {
  const tenant = await liveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "WhatsApp login isn't available for this business." });
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your WhatsApp number." });
  res.json(await container.waLogin.start({ tenantId: tenant.id, phone: parsed.data.phone, ip: clientIp(req), source: parsed.data.source ?? "site" }));
});

publicWaLoginRouter.post("/:slug/verify", async (req, res) => {
  const tenant = await liveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "WhatsApp login isn't available for this business." });
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter the code from WhatsApp." });
  res.json(await container.waLogin.verify({ tenantId: tenant.id, phone: parsed.data.phone, code: parsed.data.code }));
});

// موقع التاجر يتأكد من التوكن على السيرفر بتاعه
publicWaLoginRouter.get("/:slug/me", async (req, res) => {
  const tenant = await liveTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "WhatsApp login isn't available for this business." });
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const phone = container.waLogin.readToken(tenant.id, token);
  if (!phone) return res.status(401).json({ error: "Not signed in, or the sign-in expired." });
  res.json({ phone: "+" + phone, verified: true });
});

// صفحة الحجز: هل التاجر طالب تأكيد الرقم؟
export async function bookingNeedsWaLogin(tenant: Parameters<typeof isModuleLive>[0] & { id: string }) {
  if (!(await isModuleLive(tenant, "walogin"))) return false;
  const s = await container.waLoginStore.settings(tenant.id);
  return s.enabled && s.requireOnBooking;
}
