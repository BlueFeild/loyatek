import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { getOrCreateSettings, getAvailableSlots, createBooking, confirmBookingPaymentIfPaid } from "./bookings.service";
import { isModuleActive } from "../../utils/modules";

// راوتر عام بالكامل - العميل بيحجز موعد من غير حساب ولا تسجيل دخول،
// بالظبط زي منطق الكتالوج العام، والعزل بين الشركات بيتم عن طريق الـ slug
export const publicBookingRouter = Router();

async function findTenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, include: { branches: true } });
  // نفس منطق الكتالوج - الرابط العام يشتغل بس لو مشترك فعليًا وماكانش
  // انتهى الاشتراك
  if (!tenant || !isModuleActive(tenant, "booking")) return null;
  return tenant;
}

publicBookingRouter.get("/:slug/settings", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const settings = await getOrCreateSettings(tenant.id);
  res.json(settings);
});

publicBookingRouter.get("/:slug/resources", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const resources = await prisma.resource.findMany({ where: { tenantId: tenant.id } });
  res.json(resources);
});

publicBookingRouter.get("/:slug/slots", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const { resourceId, date } = req.query as { resourceId?: string; date?: string };
  if (!resourceId || !date) return res.status(400).json({ error: "resourceId and date are required" });

  const slots = await getAvailableSlots(tenant.id, resourceId, new Date(date));
  res.json(slots);
});

const createBookingSchema = z.object({
  resourceId: z.string().uuid(),
  customerName: z.string().min(2),
  customerPhone: z.string().min(4),
  date: z.string(),
  hour: z.number().int().min(0).max(23),
  note: z.string().optional(),
});

publicBookingRouter.post("/:slug/bookings", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const branch = tenant.branches[0];
  if (!branch) return res.status(400).json({ error: "This business has no branch set up yet" });

  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const frontendBase = process.env.FRONTEND_BASE_URL || "http://localhost:5173";
    const booking = await createBooking({
      tenantId: tenant.id,
      branchId: branch.id,
      resourceId: parsed.data.resourceId,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      date: new Date(parsed.data.date),
      hour: parsed.data.hour,
      note: parsed.data.note,
      // MyFatoorah v3 بيستخدم رابط رجوع واحد بس، وبيضيف paymentId له
      // تلقائيًا - إحنا اللي بنتأكد من الدفع الحقيقي بعد الرجوع
      redirectionUrlBase: `${frontendBase}/book/${req.params.slug}`,
    });
    res.status(201).json(booking);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// العميل بيرجع له من MyFatoorah بعد الدفع - بنتأكد من الحالة الحقيقية
// بالسؤال المباشر لـ MyFatoorah (بمفتاح التاجر)، مش بالثقة في أي حاجة
// جاية في الرابط
publicBookingRouter.get("/:slug/bookings/:id/payment-status", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const booking = await prisma.booking.findFirst({ where: { id: req.params.id, tenantId: tenant.id }, include: { resource: true } });
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const paymentId = req.query.paymentId as string | undefined;
  if (booking.paymentStatus === "AWAITING_PAYMENT" && paymentId) {
    try {
      const updated = await confirmBookingPaymentIfPaid(booking.id, paymentId);
      return res.json(updated);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
  }

  res.json(booking);
});

// العميل بيدوّر على حجوزاته برقم تليفونه من غير حساب - نفس فكرة My Bookings Portal
publicBookingRouter.get("/:slug/my-bookings", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Booking page not found" });

  const phone = req.query.phone as string | undefined;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  const bookings = await prisma.booking.findMany({
    where: { tenantId: tenant.id, customerPhone: phone },
    include: { resource: true },
    orderBy: { date: "desc" },
  });
  res.json(bookings);
});
