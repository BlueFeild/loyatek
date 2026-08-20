import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const suppliersRouter = Router();

suppliersRouter.use(requireAuth);

suppliersRouter.get("/", async (req, res) => {
  const suppliers = await prisma.supplier.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(suppliers);
});

const createSupplierSchema = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  leadTimeDays: z.number().int().min(0).default(7),
});

suppliersRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createSupplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const supplier = await prisma.supplier.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(supplier);
});
