import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

// عرض كل أصناف المخزون الخاصة بالشركة (وممكن تفلتر بفرع معين)
inventoryRouter.get("/", async (req, res) => {
  const { branchId } = req.query;
  const items = await prisma.inventoryItem.findMany({
    where: {
      tenantId: req.auth!.tenantId,
      ...(branchId ? { branchId: String(branchId) } : {}),
    },
  });
  res.json(items);
});

const createItemSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1),
  sku: z.string().min(1),
  quantity: z.number().int().min(0).default(0),
  reorderAt: z.number().int().min(0).default(0),
  costPrice: z.number().min(0),
  sellPrice: z.number().min(0),
});

inventoryRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.inventoryItem.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(item);
});

const movementSchema = z.object({
  type: z.enum(["IN", "OUT", "ADJUSTMENT"]),
  quantity: z.number().int(),
  reason: z.string().optional(),
});

// تسجيل حركة مخزون حقيقية (دخول/خروج/تسوية) - بتحدث الكمية فعليًا
// وتسجل الحركة في history حقيقي، مش رقم بيتغير بس زي الديمو
inventoryRouter.post("/:itemId/movements", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = movementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.inventoryItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.auth!.tenantId },
  });
  if (!item) return res.status(404).json({ error: "Item not found" });

  const delta =
    parsed.data.type === "IN"
      ? parsed.data.quantity
      : parsed.data.type === "OUT"
      ? -parsed.data.quantity
      : parsed.data.quantity; // ADJUSTMENT ممكن يكون موجب أو سالب

  const newQuantity = item.quantity + delta;
  if (newQuantity < 0) {
    return res.status(400).json({ error: "Movement would result in negative stock" });
  }

  const [updatedItem, movement] = await prisma.$transaction([
    prisma.inventoryItem.update({
      where: { id: item.id },
      data: { quantity: newQuantity },
    }),
    prisma.inventoryMovement.create({
      data: {
        itemId: item.id,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        reason: parsed.data.reason,
      },
    }),
  ]);

  // تنبيه نقص مخزون حقيقي (نقطة البداية لربطها بواتساب لاحقًا في الـ Automation module)
  const lowStock = updatedItem.quantity <= updatedItem.reorderAt;

  res.status(201).json({ item: updatedItem, movement, lowStockAlert: lowStock });
});

inventoryRouter.get("/:itemId/movements", async (req, res) => {
  const item = await prisma.inventoryItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.auth!.tenantId },
  });
  if (!item) return res.status(404).json({ error: "Item not found" });

  const movements = await prisma.inventoryMovement.findMany({
    where: { itemId: item.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(movements);
});
