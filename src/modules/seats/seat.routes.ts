import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { container } from "../../core/container";
import { prisma } from "../../config/db";
import { isModuleLive } from "../../utils/platform-config";
import { getTenantPaymentMethods } from "../checkout/myfatoorah";
import { publicPaymentMethods } from "../payment-settings/payment-methods";
import { getRates, isCurrencyCode, rateFor } from "../../utils/money";
import { zodMessage } from "../../utils/validation";
import { checkoutInput, eventInput, eventPatch, venueInput } from "./seat-booking.service";
import { sampleLayout } from "./seat-layout";
import { promoInput } from "./seat-pricing";
import { datesInput, sellInput, settingsInput } from "./tickets-admin.service";
import { bookingNeedsWaLogin } from "../wa-login/wa-login.routes";
import { WaLoginService } from "../wa-login/wa-login.service";
import { ValidationError } from "../../core/errors";

// الراوترات بس: تتأكد من البيانات (zod) وتنادي الخدمة - المنطق في seat-booking.service.ts
const svc = () => container.seats;
const admin = () => container.ticketsAdmin;

function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error));
  return parsed.data;
}

// ================= التاجر =================
export const seatsRouter = Router();
seatsRouter.use(requireAuth, requireModule("tickets"));
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

// ---------- إعدادات الصفحة ----------
seatsRouter.get("/settings", async (req, res) => res.json(await admin().getSettings(req.auth!.tenantId)));
seatsRouter.patch("/settings", editors, async (req, res) => res.json(await admin().saveSettings(req.auth!.tenantId, body(settingsInput, req))));

// ---------- أكواد الخصم ----------
seatsRouter.get("/promos", async (req, res) => res.json(await admin().listPromos(req.auth!.tenantId)));
seatsRouter.post("/promos", editors, async (req, res) => res.status(201).json(await admin().createPromo(req.auth!.tenantId, body(promoInput, req))));
seatsRouter.patch("/promos/:id", editors, async (req, res) => {
  // نفس قواعد الإنشاء بس كل حاجة اختيارية
  const partial = z.object({ active: z.boolean().optional(), maxUses: z.number().int().min(1).max(100_000).nullable().optional(), endsAt: z.coerce.date().nullable().optional(), startsAt: z.coerce.date().nullable().optional() });
  res.json(await admin().updatePromo(req.auth!.tenantId, req.params.id, body(partial, req)));
});
seatsRouter.delete("/promos/:id", editors, async (req, res) => {
  await admin().deletePromo(req.auth!.tenantId, req.params.id);
  res.status(204).end();
});

// ---------- بيع على الباب / تذاكر مجانية / مواعيد / تقرير / انتظار ----------
seatsRouter.post("/events/:id/sell", door, async (req, res) => {
  const input = body(sellInput, req);
  // التذكرة المجانية للمدير بس
  if (input.kind === "COMP" && !["OWNER", "ADMIN", "MANAGER"].includes(req.auth!.role)) return res.status(403).json({ error: "Only managers can give free tickets." });
  res.status(201).json(await admin().sell(req.auth!.tenantId, req.params.id, input));
});
seatsRouter.post("/events/:id/dates", editors, async (req, res) => res.status(201).json(await admin().addDates(req.auth!.tenantId, req.params.id, body(datesInput, req))));
seatsRouter.get("/events/:id/report", async (req, res) => res.json(await admin().report(req.auth!.tenantId, req.params.id)));
seatsRouter.get("/events/:id/orders.csv", async (req, res) => {
  const csv = await admin().ordersCsv(req.auth!.tenantId, req.params.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="tickets.csv"');
  res.send(csv);
});
seatsRouter.get("/events/:id/waitlist", async (req, res) => res.json(await admin().waitlist(req.auth!.tenantId, req.params.id)));
seatsRouter.post("/events/:id/waitlist/notify", editors, async (req, res) => res.json(await admin().notifyWaitlist(req.auth!.tenantId, req.params.id)));
seatsRouter.delete("/waitlist/:id", editors, async (req, res) => {
  await admin().removeWaitlist(req.auth!.tenantId, req.params.id);
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
  // خدمة التذاكر لازم تكون شغالة (اشتراك/مهلة/تجربة صاحب المنصة) والحساب مش موقوف
  if (!tenant || !(await isModuleLive(tenant, "tickets"))) return null;
  return tenant;
}

// اسم/لوجو/لون صفحة التذاكر (من إعدادات التذاكر، أو الحجز، أو اسم الشركة)
async function business(tenantId: string) {
  const b = await container.seatSettings.brand(tenantId);
  return { name: b.name, logoDataUrl: b.logoDataUrl, color: b.color, slug: b.slug, template: b.template, style: b.style, coverDataUrl: b.coverDataUrl };
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
  if (!tenant || !(await isModuleLive(tenant, "tickets"))) return res.status(404).json({ error: "Ticket not found" });
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  const { tenantId: _t, ...ticket } = t;
  res.json({ ...ticket, business: await business(tenant.id), currency, rate: rateFor(currency, await getRates()) });
});

publicSeatsRouter.get("/:slug/events", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  res.json({ business: await business(tenant.id), currency, rate: rateFor(currency, await getRates()), events: await svc().publicEvents(tenant.id) });
});

publicSeatsRouter.get("/:slug/events/:id", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  const event = await svc().publicEvent(tenant.id, req.params.id);
  const currency = isCurrencyCode(tenant.displayCurrency) ? tenant.displayCurrency : "USD";
  res.json({
    ...event,
    business: await business(tenant.id),
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
  const input = body(
    z.object({
      seatIds: z.array(z.string().max(12)).max(50).default([]),
      // "اختارلي أحسن كراسي"
      best: z.object({ count: z.number().int().min(1).max(50), tierId: z.string().max(24).nullable().optional() }).optional(),
      replaceOrderId: z.string().uuid().optional(),
      replaceToken: z.string().max(80).optional(),
    }),
    req
  );
  res.status(201).json(await svc().hold(tenant.id, req.params.id, input.seatIds, { orderId: input.replaceOrderId, token: input.replaceToken }, input.best));
});

// قائمة الانتظار لعرض كامل
publicSeatsRouter.post("/:slug/events/:id/waitlist", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  if (tooManyHolds(req.ip || "?")) return res.status(429).json({ error: "Too many tries — please wait a few minutes." });
  const input = body(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().min(6).max(30), email: z.union([z.literal(""), z.string().trim().email().max(200)]).optional(), seats: z.number().int().min(1).max(50).default(1) }), req);
  res.status(201).json(await svc().joinWaitlist(tenant.id, req.params.id, input));
});

// العميل كتب كود خصم: السعر الجديد (الكود بيتستهلك وقت الدفع بس)
publicSeatsRouter.post("/:slug/orders/:id/promo", async (req, res) => {
  const tenant = await tenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Page not found" });
  if (tooManyHolds(req.ip || "?")) return res.status(429).json({ error: "Too many tries — please wait a few minutes." });
  const input = body(z.object({ holdToken: z.string().max(80), code: z.string().trim().min(1).max(24) }), req);
  res.json(await svc().previewPromo(tenant.id, req.params.id, input.holdToken, input.code));
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
