import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { assertTenantOwns } from "../../utils/tenant-owned";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth, requireModule("erp"));

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
  expiryDate: z.string().nullable().optional(),
});

inventoryRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await assertTenantOwns(req.auth!.tenantId, { branchIds: [parsed.data.branchId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const item = await prisma.inventoryItem.create({
    data: {
      tenantId: req.auth!.tenantId,
      ...parsed.data,
      expiryDate: parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : undefined,
    },
  });
  res.status(201).json(item);
});

export const movementSchema = z
  .object({
    type: z.enum(["IN", "OUT", "ADJUSTMENT", "WASTAGE"]),
    quantity: z.number().int().min(-1_000_000).max(1_000_000),
    reason: z.string().max(500).optional(),
  })
  // IN/OUT/WASTAGE لازم موجبة (OUT بكمية سالبة كانت بتزوّد المخزون)؛ ADJUSTMENT موجبة أو سالبة بس مش صفر
  .refine((d) => (d.type === "ADJUSTMENT" ? d.quantity !== 0 : d.quantity > 0), {
    message: "quantity must be a positive whole number (ADJUSTMENT: any non-zero number)",
    path: ["quantity"],
  });

// تسجيل حركة مخزون حقيقية (دخول/خروج/تسوية/تلف) - بتحدث الكمية فعليًا
// وتسجل الحركة في history حقيقي، مش رقم بيتغير بس زي الديمو
inventoryRouter.post("/:itemId/movements", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = movementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const item = await prisma.inventoryItem.findFirst({
    where: { id: req.params.itemId, tenantId: req.auth!.tenantId },
  });
  if (!item) return res.status(404).json({ error: "Item not found" });

  // WASTAGE بتخصم من المخزون زي OUT بالظبط، لكن بتتسجل منفصلة في الـ
  // history عشان تقدري تفرّقي بين اللي اتباع فعليًا واللي اتلف/انتهى
  const delta =
    parsed.data.type === "IN"
      ? parsed.data.quantity
      : parsed.data.type === "OUT" || parsed.data.type === "WASTAGE"
      ? -parsed.data.quantity
      : parsed.data.quantity; // ADJUSTMENT ممكن يكون موجب أو سالب

  // تحديث ذري: الخصم بيحصل بس لو الرصيد يكفي وقت الكتابة نفسها (قبل كده طلبين في نفس
  // اللحظة كانوا بيقروا نفس الرصيد ويكتبوا فوق بعض، فالمخزون بيتصرف أكتر من الموجود)
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.inventoryItem.updateMany({
      where: { id: item.id, tenantId: req.auth!.tenantId, ...(delta < 0 ? { quantity: { gte: -delta } } : {}) },
      data: { quantity: { increment: delta } },
    });
    if (changed.count === 0) return null;
    const movement = await tx.inventoryMovement.create({
      data: {
        itemId: item.id,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        reason: parsed.data.reason,
      },
    });
    const updatedItem = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    return { updatedItem, movement };
  });
  if (!result) {
    return res.status(400).json({ error: "Movement would result in negative stock" });
  }
  const { updatedItem, movement } = result;

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

// تقرير التلف والصلاحية - تكلفة التلف الحقيقية محسوبة من حركات
// WASTAGE الفعلية × سعر التكلفة الحقيقي، والأصناف اللي انتهت أو
// هتنتهي خلال 30 يوم القادمين
interface ItemWithWastageMovements {
  id: string;
  name: string;
  costPrice: unknown; // Prisma Decimal - بيتحول بـ Number() وقت الاستخدام
  quantity: number;
  expiryDate: Date | null;
  movements: { quantity: number; createdAt: Date }[];
}

inventoryRouter.get("/reports/wastage-expiry", async (req, res) => {
  const items: ItemWithWastageMovements[] = await prisma.inventoryItem.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { movements: { where: { type: "WASTAGE" }, orderBy: { createdAt: "desc" } } },
  });

  const wastageByItem = items
    .filter((i) => i.movements.length > 0)
    .map((i) => ({
      itemId: i.id,
      itemName: i.name,
      totalWastedUnits: i.movements.reduce((sum, m) => sum + m.quantity, 0),
      totalWastedCost: i.movements.reduce((sum, m) => sum + m.quantity * Number(i.costPrice), 0),
      lastWastageDate: i.movements[0]?.createdAt ?? null,
    }));

  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expiring = items
    .filter((i) => i.expiryDate && new Date(i.expiryDate) <= in30Days)
    .map((i) => ({
      itemId: i.id,
      itemName: i.name,
      quantity: i.quantity,
      expiryDate: i.expiryDate,
      alreadyExpired: new Date(i.expiryDate!) < new Date(),
    }))
    .sort((a, b) => new Date(a.expiryDate!).getTime() - new Date(b.expiryDate!).getTime());

  res.json({
    wastageByItem,
    totalWastedCostAllTime: wastageByItem.reduce((sum, w) => sum + w.totalWastedCost, 0),
    expiring,
  });
});
