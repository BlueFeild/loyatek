import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getOrCreateCatalogSettings, updateCatalogSettings, createOrder } from "./catalog.service";

export const catalogRouter = Router();

catalogRouter.use(requireAuth);

// --- Settings ---

catalogRouter.get("/settings", async (req, res) => {
  const settings = await getOrCreateCatalogSettings(req.auth!.tenantId);
  res.json(settings);
});

const updateSettingsSchema = z.object({
  brandName: z.string().optional(),
  brandLogoDataUrl: z.string().nullable().optional(),
  menuLayout: z.enum(["list", "grid", "gallery", "story"]).optional(),
  dineInEnabled: z.boolean().optional(),
  pickupEnabled: z.boolean().optional(),
  tableCount: z.number().int().min(1).optional(),
  merchantEmail: z.string().optional(),
  kitchenWhatsapp: z.string().optional(),
  prepTime: z.number().int().min(5).optional(),
  themeColor: z.string().optional(),
});

catalogRouter.patch("/settings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await updateCatalogSettings(req.auth!.tenantId, parsed.data);
  res.json(settings);
});

// --- Categories ---

catalogRouter.get("/categories", async (req, res) => {
  const categories = await prisma.menuCategory.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
  res.json(categories);
});

const createCategorySchema = z.object({ name: z.string().min(1) });

catalogRouter.post("/categories", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const count = await prisma.menuCategory.count({ where: { tenantId: req.auth!.tenantId } });
  const category = await prisma.menuCategory.create({
    data: { tenantId: req.auth!.tenantId, name: parsed.data.name, sortOrder: count },
  });
  res.status(201).json(category);
});

const updateCategorySchema = z.object({ name: z.string().optional(), coverImageDataUrl: z.string().nullable().optional() });

catalogRouter.patch("/categories/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateCategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const updated = await prisma.menuCategory.update({ where: { id: category.id }, data: parsed.data });
  res.json(updated);
});

catalogRouter.delete("/categories/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const category = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!category) return res.status(404).json({ error: "Category not found" });

  await prisma.menuCategory.delete({ where: { id: category.id } });
  res.json({ ok: true });
});

// --- Menu Items ---

const createItemSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().min(0),
});

catalogRouter.post("/items", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await prisma.menuCategory.findFirst({
    where: { id: parsed.data.categoryId, tenantId: req.auth!.tenantId },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const count = await prisma.menuItem.count({ where: { categoryId: category.id } });
  const item = await prisma.menuItem.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data, sortOrder: count },
  });
  res.status(201).json(item);
});

const updateItemSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.number().min(0).optional(),
  photoDataUrl: z.string().nullable().optional(),
});

catalogRouter.patch("/items/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!item) return res.status(404).json({ error: "Item not found" });

  const updated = await prisma.menuItem.update({ where: { id: item.id }, data: parsed.data });
  res.json(updated);
});

catalogRouter.delete("/items/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const item = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!item) return res.status(404).json({ error: "Item not found" });

  await prisma.menuItem.delete({ where: { id: item.id } });
  res.json({ ok: true });
});

// --- Orders ---

catalogRouter.get("/orders", async (req, res) => {
  const orders = await prisma.catalogOrder.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

const createOrderSchema = z.object({
  branchId: z.string().uuid(),
  mode: z.enum(["DINE_IN", "PICKUP"]),
  tableNumber: z.number().int().optional(),
  readyTime: z.number().int().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  items: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().positive() })).min(1),
});

catalogRouter.post("/orders", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await createOrder({ tenantId: req.auth!.tenantId, ...parsed.data });
    res.status(201).json(order);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
