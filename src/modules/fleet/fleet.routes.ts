import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const fleetRouter = Router();
fleetRouter.use(requireAuth);

fleetRouter.get("/", async (req, res) => {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { serviceLogs: { orderBy: { serviceDate: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(vehicles);
});

const createVehicleSchema = z.object({
  plateNumber: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().min(1980),
  mileage: z.number().int().min(0).default(0),
  nextServiceDate: z.string().nullable().optional(),
});

fleetRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createVehicleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.findFirst({ where: { tenantId: req.auth!.tenantId } });
  if (!branch) return res.status(400).json({ error: "No branch found for this company" });

  try {
    const vehicle = await prisma.vehicle.create({
      data: {
        tenantId: req.auth!.tenantId,
        branchId: branch.id,
        plateNumber: parsed.data.plateNumber,
        make: parsed.data.make,
        model: parsed.data.model,
        year: parsed.data.year,
        mileage: parsed.data.mileage,
        nextServiceDate: parsed.data.nextServiceDate ? new Date(parsed.data.nextServiceDate) : undefined,
      },
    });
    res.status(201).json(vehicle);
  } catch (err: any) {
    if (err.code === "P2002") return res.status(400).json({ error: "A vehicle with this plate number already exists" });
    throw err;
  }
});

const updateVehicleSchema = z.object({
  status: z.enum(["ACTIVE", "IN_SERVICE", "RETIRED"]).optional(),
  mileage: z.number().int().min(0).optional(),
  nextServiceDate: z.string().nullable().optional(),
});

fleetRouter.patch("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateVehicleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      ...parsed.data,
      nextServiceDate: parsed.data.nextServiceDate !== undefined ? (parsed.data.nextServiceDate ? new Date(parsed.data.nextServiceDate) : null) : undefined,
    },
  });
  res.json(updated);
});

const addServiceLogSchema = z.object({
  description: z.string().min(1),
  cost: z.number().min(0),
  mileageAt: z.number().int().min(0),
});

fleetRouter.post("/:id/service-logs", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = addServiceLogSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vehicle = await prisma.vehicle.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

  const log = await prisma.vehicleServiceLog.create({
    data: { vehicleId: vehicle.id, ...parsed.data },
  });
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { mileage: parsed.data.mileageAt, status: "ACTIVE" } });
  res.status(201).json(log);
});
