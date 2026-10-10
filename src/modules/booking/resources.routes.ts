import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

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

  const resource = await prisma.resource.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(resource);
});

// حذف مورد - بيرفض الحذف لو عليه حجوزات حقيقية مرتبطة بيه، عشان
// محدش يمسح مورد بالغلط ويفقد سجل حجوزات عميل حقيقي
resourcesRouter.delete("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const resource = await prisma.resource.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!resource) return res.status(404).json({ error: "Resource not found" });

  const bookingCount = await prisma.booking.count({ where: { resourceId: resource.id } });
  if (bookingCount > 0) {
    return res.status(400).json({ error: `This resource has ${bookingCount} real booking(s) linked to it and can't be deleted.` });
  }

  await prisma.resource.delete({ where: { id: resource.id } });
  res.json({ ok: true });
});
