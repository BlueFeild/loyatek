import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { getOrCreateWalletSettings } from "./wallet.service";

// راوتر عام بالكامل - العميل بينضم لبرنامج الولاء بنفسه من غير حساب،
// بالظبط زي منطق الكتالوج والحجز العامين
export const publicWalletRouter = Router();

async function findTenantBySlug(slug: string) {
  return prisma.tenant.findUnique({ where: { slug } });
}

publicWalletRouter.get("/:slug/settings", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Loyalty program not found" });

  const settings = await getOrCreateWalletSettings(tenant.id);
  res.json(settings);
});

const joinSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(4),
});

publicWalletRouter.post("/:slug/join", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Loyalty program not found" });

  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const customer = await prisma.walletCustomer.create({
      data: { tenantId: tenant.id, name: parsed.data.name, phone: parsed.data.phone, tier: "SILVER" },
    });
    res.status(201).json(customer);
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "This phone number is already registered in the loyalty program" });
    }
    throw err;
  }
});

// العميل بيدوّر على رصيده برقم تليفونه من غير حساب
publicWalletRouter.get("/:slug/lookup", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Loyalty program not found" });

  const phone = req.query.phone as string | undefined;
  if (!phone) return res.status(400).json({ error: "phone is required" });

  const customer = await prisma.walletCustomer.findUnique({
    where: { tenantId_phone: { tenantId: tenant.id, phone } },
  });
  if (!customer) return res.status(404).json({ error: "No membership found for this number" });

  res.json(customer);
});
