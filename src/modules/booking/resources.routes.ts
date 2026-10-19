import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { assertTenantOwns } from "../../utils/tenant-owned";

export const resourcesRouter = Router();

resourcesRouter.use(requireAuth);

resourcesRouter.get("/", async (req, res) => {
  const resources = await prisma.resource.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(resources);
});

const createResourceSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(2),
  type: z.enum(["STAFF", "LOCATION"]),
});

resourcesRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createResourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await assertTenantOwns(req.auth!.tenantId, { branchIds: [parsed.data.branchId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const resource = await prisma.resource.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(resource);
});

// حذف مورد - لو عليه حجوزات بيرفض الأول ويرجّع عددها (409)، عشان محدش يمسح
// سجل حجوزات حقيقي بالغلط. لو التاجر أكّد (?withBookings=1) بيتمسح هو
// وحجوزاته مع بعض (OWNER / ADMIN بس)
resourcesRouter.delete("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const resource = await prisma.resource.findFirst({ where: { id: req.params.id, tenantId } });
  if (!resource) return res.status(404).json({ error: "Resource not found" });

  const bookingCount = await prisma.booking.count({ where: { resourceId: resource.id, tenantId } });
  const withBookings = req.query.withBookings === "1";
  if (bookingCount > 0 && !withBookings) {
    return res.status(409).json({
      error: `This resource has ${bookingCount} booking(s). Delete it together with its bookings?`,
      bookingCount,
    });
  }
  if (bookingCount > 0 && !["OWNER", "ADMIN"].includes(req.auth!.role)) {
    return res.status(403).json({ error: "Only the owner or an admin can delete a resource together with its bookings." });
  }

  await prisma.$transaction([
    prisma.booking.deleteMany({ where: { resourceId: resource.id, tenantId } }),
    prisma.resource.delete({ where: { id: resource.id } }),
  ]);
  res.json({ ok: true, deletedBookings: bookingCount });
});
