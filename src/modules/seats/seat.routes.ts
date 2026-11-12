import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { prisma } from "../../config/db";
import { isModuleLive } from "../../utils/platform-config";
import { getTenantPaymentMethods } from "../checkout/myfatoorah";
import { publicPaymentMethods } from "../payment-settings/payment-methods";
import { getRates, isCurrencyCode, rateFor } from "../../utils/money";
import { zodMessage } from "../../utils/validation";
import { checkoutInput, eventInput, eventPatch, venueInput } from "./seat-booking.service";
import { sampleLayout } from "./seat-layout";
import { bookingNeedsWaLogin } from "../wa-login/wa-login.routes";
import { WaLoginService } from "../wa-login/wa-login.service";
import { ValidationError } from "../../core/errors";

// الراوترات بس: تتأكد من البيانات (zod) وتنادي الخدمة - المنطق في seat-booking.service.ts
const svc = () => container.seats;

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
  return parsed.data;
}

// ================= التاجر =================
export const seatsRouter = Router();
seatsRouter.use(requireAuth);
const editors = requireRole("OWNER", "ADMIN", "MANAGER");
const door = requireRole("OWNER", "ADMIN", "MANAGER", "STAFF");

seatsRouter.get("/sample-layout", (_req, res) => res.json(sampleLayout()));
seatsRouter.get("/venues", async (req, res) => res.json(await svc().listVenues(req.auth!.tenantId)));
seatsRouter.post("/venues", editors, async (req, res) => res.status(201).json(await svc().createVenue(req.auth!.tenantId, body(venueInput, req))));
seatsRouter.patch("/venues/:id", editors, async (req, res) => res.json(await svc().updateVenue(req.auth!.tenantId, req.params.id, body(venueInput.partial(), req))));
seatsRouter.delete("/venues/:id", editors, async (req, res) => {
  await svc().deleteVenue(req.auth!.tenantId, req.params.id);
  res.status(204).end();
});

seatsRouter.get("/events", async (req, res) => res.json(await svc().listEvents(req.auth!.tenantId)));
seatsRouter.post("/events", editors, async (req, res) => res.status(201).json(await svc().createEvent(req.auth!.tenantId, body(eventInput, req))));
seatsRouter.get("/events/:id", async (req, res) => res.json(await svc().eventDetail(req.auth!.tenantId, req.params.id)));
seatsRouter.patch("/events/:id", editors, async (req, res) => res.json(await svc().updateEvent(req.auth!.tenantId, req.params.id, body(eventPatch, req))));
seatsRouter.delete("/events/:id", editors, async (req, res) => {
  await svc().deleteEvent(req.auth!.tenantId, req.params.id);
  res.status(204).end();
});

seatsRouter.post("/orders/:id/paid", door, async (req, res) => res.json(await svc().markPaid(req.auth!.tenantId, req.params.id)));
seatsRouter.post("/orders/:id/cancel", editors, async (req, res) => res.json(await svc().cancelOrder(req.auth!.tenantId, req.params.id)));
seatsRouter.post("/check-in", door, async (req, res) => {
  const { code } = body(z.object({ code: z.string().trim().min(4).max(300) }), req);
  res.json(await svc().checkIn(req.auth!.tenantId, code));
});

// ================= العميل (من غير حساب) =================
export const publicSeatsRouter = Router();

async function tenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  // نفس قاعدة صفحة الحجز: الاشتراك شغال والحساب مش موقوف
  if (!tenant || !(await isModuleLive(tenant, "booking"))) return null;
  return tenant;
}

// كام حجز مؤقت لكل IP في 10 دقايق (يمنع حد يقفل القاعة كلها بسكربت)
const holdHits = new Map<string, number[]>();
function tooManyHolds(ip: string) {
  const now = Date.now();
  const list = (holdHits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  list.push(now);
  holdHits.set(ip, list);
  if (holdHits.size > 5000) holdHits.clear();
  return list.length > 30;
}

publicSeatsRouter.get("/tickets/:code", async (req, res) => {
  const t = await svc().ticket(req.params.code);
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  const tenant = await prisma.tenant.findUnique({ where: { id: t.tenantId } });
  if (!tenant || !(await isModuleLive(tenant, "booking"))) return res.status(404).json({ error: "Ticket not found" });
  const s = await prisma.bookingSettings.findUnique({ where: { tenantId: tenant.id }, select: { brandName: true, logoDataUrl: true, themeColor: true } });
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  const { tenantId: _t, ...ticket } = t;
  res.json({ ...ticket, business: { name: s?.brandName || tenant.name, logoDataUrl: s?.logoDataUrl ?? null, color: s?.themeColor ?? null, slug: tenant.slug }, currency, rate: rateFor(currency, await getRates()) });
});

publicSeatsRouter.get("/:slug/events", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const s = await prisma.bookingSettings.findUnique({ where: { tenantId: tenant.id }, select: { brandName: true, logoDataUrl: true, themeColor: true } });
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  res.json({ business: { name: s?.brandName || tenant.name, logoDataUrl: s?.logoDataUrl ?? null, color: s?.themeColor ?? null }, currency, rate: rateFor(currency, await getRates()), events: await svc().publicEvents(tenant.id) });
});

publicSeatsRouter.get("/:slug/events/:id", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const event = await svc().publicEvent(tenant.id, req.params.id);
  const s = await prisma.bookingSettings.findUnique({ where: { tenantId: tenant.id }, select: { brandName: true, logoDataUrl: true, themeColor: true } });
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  res.json({
    ...event,
    business: { name: s?.brandName || tenant.name, logoDataUrl: s?.logoDataUrl ?? null, color: s?.themeColor ?? null },
    currency,
    rate: rateFor(currency, await getRates()),
    paymentMethods: publicPaymentMethods(await getTenantPaymentMethods(tenant.id)),
    whatsappLogin: { required: await bookingNeedsWaLogin(tenant) },
  });
});

publicSeatsRouter.post("/:slug/events/:id/hold", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  if (tooManyHolds(req.ip || "?")) return res.status(429).json({ error: "Too many tries — please wait a few minutes." });
  const input = body(z.object({ seatIds: z.array(z.string().max(12)).min(1).max(50), replaceOrderId: z.string().uuid().optional(), replaceToken: z.string().max(80).optional() }), req);
  res.status(201).json(await svc().hold(tenant.id, req.params.id, input.seatIds, { orderId: input.replaceOrderId, token: input.replaceToken }));
});

publicSeatsRouter.post("/:slug/orders/:id/release", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const { holdToken } = body(z.object({ holdToken: z.string().max(80) }), req);
  await svc().release(tenant.id, req.params.id, holdToken);
  res.status(204).end();
});

publicSeatsRouter.post("/:slug/orders/:id/checkout", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const input = body(checkoutInput.extend({ waLoginToken: z.string().max(2000).optional() }), req);
  // التاجر طالب تأكيد رقم الواتساب: لازم توكن سليم لنفس الرقم
  if (await bookingNeedsWaLogin(tenant)) {
    const verified = container.waLogin.readToken(tenant.id, input.waLoginToken);
    if (!verified || !WaLoginService.samePhone(verified, input.customerPhone)) {
      return res.status(401).json({ error: "Please confirm your WhatsApp number with the code first.", code: "WA_LOGIN_REQUIRED" });
    }
  }
  const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
  res.json(await svc().checkout(tenant.id, req.params.id, input, `${frontendBase}/events/${req.params.slug}`));
});

publicSeatsRouter.get("/:slug/orders/:id/payment-status", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  res.json(await svc().confirmPayment(tenant.id, req.params.id, (req.query.paymentId as string | undefined) || undefined));
});
