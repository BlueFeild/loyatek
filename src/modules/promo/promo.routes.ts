import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { hasModuleAccess } from "../../middleware/module-access";
import { bypassesAccountChecks } from "../../utils/jwt";
import { prisma } from "../../config/db";
import { isModuleLive } from "../../utils/platform-config";
import { zodMessage } from "../../utils/validation";
import { SlidingWindowLimiter, envNumber } from "../../utils/rate-limit";
import { clientIp } from "../../utils/visitor-country";
import { PROMO_MODULE, PROMO_SERVICES, promoInput, promoPatch, type PromoService } from "./promo.logic";
import { promoCodes } from "./promo.wiring";

const serviceSchema = z.enum(PROMO_SERVICES);
const idSchema = z.string().uuid();

// ---------- لوحة التاجر: /api/promo-codes?service=booking|menu ----------
export const promoRouter = Router();
promoRouter.use(requireAuth);

// الخدمة لازم تكون مكتوبة، والشركة مشتركة فيها (نفس قاعدة باقي الصفحات)
async function withService(req: Request, res: Response, next: NextFunction) {
  const parsed = serviceSchema.safeParse(req.query.service);
  if (!parsed.success) return res.status(400).json({ error: "service must be booking or menu", code: "VALIDATION_ERROR" });
  const service = parsed.data;
  const auth = req.auth!;
  if (!bypassesAccountChecks(auth) && !(await hasModuleAccess(auth.tenantId, PROMO_MODULE[service]))) {
    return res.status(403).json({ error: "This service isn't active on your account.", code: "MODULE_INACTIVE", module: PROMO_MODULE[service] });
  }
  res.locals.service = service;
  next();
}
const svc = (res: Response) => res.locals.service as PromoService;
const writers = requireRole("OWNER", "ADMIN", "MANAGER");

promoRouter.get("/", withService, async (req, res) => {
  res.json(await promoCodes.list(req.auth!.tenantId, svc(res)));
});

promoRouter.post("/", writers, withService, async (req, res) => {
  const parsed = promoInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error), code: "VALIDATION_ERROR" });
  res.status(201).json(await promoCodes.create(req.auth!.tenantId, svc(res), parsed.data));
});

promoRouter.patch("/:id", writers, withService, async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "Code not found" });
  const parsed = promoPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error), code: "VALIDATION_ERROR" });
  res.json(await promoCodes.update(req.auth!.tenantId, svc(res), id.data, parsed.data));
});

promoRouter.delete("/:id", writers, withService, async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "Code not found" });
  await promoCodes.remove(req.auth!.tenantId, svc(res), id.data);
  res.status(204).end();
});

// ---------- عام: العميل بيجرّب الكود قبل ما يحجز/يطلب ----------
// حد لكل جهاز عشان محدش يخمّن الأكواد بسكريبت
const checkLimiter = new SlidingWindowLimiter(envNumber("PUBLIC_PROMO_CHECKS_PER_10MIN", 30), 10 * 60_000);

const checkSchema = z.object({
  service: serviceSchema,
  code: z.string().trim().min(1).max(40),
  subtotalUsd: z.number().finite().min(0).max(10_000_000).nullable().optional(),
});

export const publicPromoRouter = Router();

publicPromoRouter.post("/:slug/check", async (req, res) => {
  if (checkLimiter.hit(clientIp(req))) {
    return res.status(429).json({ error: "Too many tries — please wait a few minutes.", code: "RATE_LIMITED" });
  }
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error), code: "VALIDATION_ERROR" });
  const tenant = await prisma.tenant.findUnique({ where: { slug: String(req.params.slug) } });
  if (!tenant || !(await isModuleLive(tenant, PROMO_MODULE[parsed.data.service]))) return res.status(404).json({ error: "Page not found" });
  res.json(await promoCodes.check(tenant.id, parsed.data.service, parsed.data.code, parsed.data.subtotalUsd ?? null));
});
