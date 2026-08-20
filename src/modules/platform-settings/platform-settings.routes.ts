import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { getPlatformSettings } from "../checkout/myfatoorah";
import { prisma } from "../../config/db";

export const platformSettingsRouter = Router();

platformSettingsRouter.use(requireAuth, requireSuperAdmin);

platformSettingsRouter.get("/", async (_req, res) => {
  const settings = await getPlatformSettings();
  // ميرجعش المفتاح كامل للفرونت إند - بس آخر 4 حروف عشان تتأكدي إنه محفوظ
  res.json({
    isConnected: Boolean(settings.myFatoorahApiKey),
    myFatoorahIsTest: settings.myFatoorahIsTest,
    keyPreview: settings.myFatoorahApiKey ? `••••${settings.myFatoorahApiKey.slice(-4)}` : null,
  });
});

const updateSchema = z.object({
  myFatoorahApiKey: z.string().min(10),
  myFatoorahIsTest: z.boolean().default(true),
});

platformSettingsRouter.patch("/", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getPlatformSettings();
  await prisma.platformSettings.update({ where: { id: "singleton" }, data: parsed.data });
  res.json({ ok: true });
});
