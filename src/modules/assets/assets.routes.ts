import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const assetsRouter = Router();
assetsRouter.use(requireAuth);

// إهلاك خطي حقيقي: (سعر الشراء - قيمة الخردة) / سنين العمر الافتراضي،
// مضروبة في عدد السنين اللي عدّت فعليًا من تاريخ الشراء لحد دلوقتي
function computeDepreciation(asset: {
  purchaseDate: Date;
  purchaseValue: number;
  usefulLifeYears: number;
  salvageValue: number;
}) {
  const yearsElapsed = (Date.now() - asset.purchaseDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  const annualDepreciation = (asset.purchaseValue - asset.salvageValue) / asset.usefulLifeYears;
  const accumulatedDepreciation = Math.min(
    annualDepreciation * Math.max(0, yearsElapsed),
    asset.purchaseValue - asset.salvageValue
  );
  const currentValue = Math.max(asset.salvageValue, asset.purchaseValue - accumulatedDepreciation);
  return {
    annualDepreciation: Math.round(annualDepreciation * 100) / 100,
    accumulatedDepreciation: Math.round(accumulatedDepreciation * 100) / 100,
    currentValue: Math.round(currentValue * 100) / 100,
  };
}

assetsRouter.get("/", async (req, res) => {
  const assets = await prisma.fixedAsset.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });

  const withDepreciation = assets.map((a: any) => ({
    ...a,
    ...computeDepreciation({
      purchaseDate: a.purchaseDate,
      purchaseValue: Number(a.purchaseValue),
      usefulLifeYears: a.usefulLifeYears,
      salvageValue: Number(a.salvageValue),
    }),
  }));

  res.json(withDepreciation);
});

const createAssetSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  purchaseDate: z.string(),
  purchaseValue: z.number().min(0),
  usefulLifeYears: z.number().int().min(1).default(5),
  salvageValue: z.number().min(0).default(0),
});

assetsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createAssetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.findFirst({ where: { tenantId: req.auth!.tenantId } });
  if (!branch) return res.status(400).json({ error: "No branch found for this company" });

  const asset = await prisma.fixedAsset.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: branch.id,
      name: parsed.data.name,
      category: parsed.data.category ?? "Equipment",
      purchaseDate: new Date(parsed.data.purchaseDate),
      purchaseValue: parsed.data.purchaseValue,
      usefulLifeYears: parsed.data.usefulLifeYears,
      salvageValue: parsed.data.salvageValue,
    },
  });
  res.status(201).json(asset);
});

assetsRouter.delete("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!asset) return res.status(404).json({ error: "Asset not found" });

  await prisma.fixedAsset.delete({ where: { id: asset.id } });
  res.json({ ok: true });
});
