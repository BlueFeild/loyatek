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
