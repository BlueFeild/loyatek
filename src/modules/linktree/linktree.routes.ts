import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const linktreeRouter = Router();
linktreeRouter.use(requireAuth);

async function getOrCreateSettings(tenantId: string) {
  const existing = await prisma.linktreeSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.linktreeSettings.create({ data: { tenantId } });
}

linktreeRouter.get("/settings", async (req, res) => {
  res.json(await getOrCreateSettings(req.auth!.tenantId));
});

const updateSettingsSchema = z.object({
  displayName: z.string().min(1).optional(),
  bio: z.string().optional(),
  avatarDataUrl: z.string().nullable().optional(),
  themeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

linktreeRouter.patch("/settings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateSettings(req.auth!.tenantId);
  const updated = await prisma.linktreeSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: parsed.data,
  });
  res.json(updated);
});

linktreeRouter.get("/links", async (req, res) => {
  const links = await prisma.linktreeLink.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { sortOrder: "asc" },
  });
  res.json(links);
});

const createLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
});

linktreeRouter.post("/links", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const maxOrder = await prisma.linktreeLink.aggregate({
    where: { tenantId: req.auth!.tenantId },
    _max: { sortOrder: true },
  });

  const link = await prisma.linktreeLink.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1 },
  });
  res.status(201).json(link);
});

const updateLinkSchema = z.object({
  label: z.string().min(1).optional(),
  url: z.string().url().optional(),
  sortOrder: z.number().int().optional(),
});

linktreeRouter.patch("/links/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const link = await prisma.linktreeLink.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!link) return res.status(404).json({ error: "Link not found" });

  const updated = await prisma.linktreeLink.update({ where: { id: link.id }, data: parsed.data });
  res.json(updated);
});

linktreeRouter.delete("/links/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const link = await prisma.linktreeLink.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!link) return res.status(404).json({ error: "Link not found" });

  await prisma.linktreeLink.delete({ where: { id: link.id } });
  res.json({ ok: true });
});
