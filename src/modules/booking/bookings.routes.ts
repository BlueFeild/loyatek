import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import {
  getOrCreateSettings,
  updateSettings,
  getAvailableSlots,
  createBooking,
  cancelBooking,
  rescheduleBooking,
  getBookingStats,
} from "./bookings.service";

export const bookingsRouter = Router();

bookingsRouter.use(requireAuth);

// --- Settings ---

bookingsRouter.get("/settings", async (req, res) => {
  const settings = await getOrCreateSettings(req.auth!.tenantId);
  res.json(settings);
});

const updateSettingsSchema = z.object({
  industry: z.string().optional(),
  brandName: z.string().optional(),
  logoDataUrl: z.string().nullable().optional(),
  services: z.array(z.string()).optional(),
  openHour: z.number().int().min(0).max(23).optional(),
  closeHour: z.number().int().min(1).max(24).optional(),
  disabledHours: z.array(z.number().int()).optional(),
  slotDurationMin: z.number().int().min(5).optional(),
  bufferMin: z.number().int().min(0).optional(),
  peakFlag: z.boolean().optional(),
  waAutomation: z.boolean().optional(),
  waTemplate: z.string().optional(),
  allocationMode: z.enum(["staff", "asset"]).optional(),
  themeColor: z.string().optional(),
});

bookingsRouter.patch("/settings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await updateSettings(req.auth!.tenantId, parsed.data);
  res.json(settings);
});

// --- Availability ---

bookingsRouter.get("/slots", async (req, res) => {
  const { resourceId, date } = req.query as { resourceId?: string; date?: string };
  if (!resourceId || !date) return res.status(400).json({ error: "resourceId and date are required" });

  const slots = await getAvailableSlots(req.auth!.tenantId, resourceId, new Date(date));
  res.json(slots);
});

// --- Bookings ---

bookingsRouter.get("/", async (req, res) => {
  const phone = req.query.phone as string | undefined;
  const bookings = await prisma.booking.findMany({
    where: { tenantId: req.auth!.tenantId, ...(phone ? { customerPhone: phone } : {}) },
    include: { resource: true },
    orderBy: { date: "desc" },
  });
  res.json(bookings);
});

const createBookingSchema = z.object({
  branchId: z.string().uuid(),
  resourceId: z.string().uuid(),
  customerName: z.string().min(2),
  customerPhone: z.string().min(4),
  date: z.string(),
  hour: z.number().int().min(0).max(23),
  note: z.string().optional(),
});

bookingsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const booking = await createBooking({
      tenantId: req.auth!.tenantId,
      branchId: parsed.data.branchId,
      resourceId: parsed.data.resourceId,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      date: new Date(parsed.data.date),
      hour: parsed.data.hour,
      note: parsed.data.note,
    });
    res.status(201).json(booking);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

bookingsRouter.post("/:id/cancel", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  try {
    const booking = await cancelBooking(req.auth!.tenantId, req.params.id);
    res.json(booking);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const rescheduleSchema = z.object({ date: z.string(), hour: z.number().int().min(0).max(23) });

bookingsRouter.post("/:id/reschedule", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const booking = await rescheduleBooking(req.auth!.tenantId, req.params.id, new Date(parsed.data.date), parsed.data.hour);
    res.json(booking);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Stats ---

bookingsRouter.get("/stats", async (req, res) => {
  const branchId = req.query.branchId as string;
  if (!branchId) return res.status(400).json({ error: "branchId is required" });

  const stats = await getBookingStats(req.auth!.tenantId, branchId);
  res.json(stats);
});
