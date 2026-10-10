import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { getOrCreateWalletSettings } from "./wallet.service";
import { isModuleActive } from "../../utils/modules";
import { loadGoogleWalletConfig } from "./google-wallet.service";
import { createGooglePassLink, publicBaseUrl } from "./wallet-pass.service";
import { solidColorPng } from "./png";

// راوتر عام بالكامل - العميل بينضم لبرنامج الولاء بنفسه من غير حساب،
// بالظبط زي منطق الكتالوج والحجز العامين
export const publicWalletRouter = Router();

async function findTenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  // نفس منطق الكتالوج والحجز - الرابط العام يشتغل بس لو مشترك فعليًا
  // وماكانش انتهى الاشتراك
  if (!tenant || !isModuleActive(tenant, "wallet")) return null;
  return tenant;
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

    // لو Google Wallet متظبط على السيرفر بنجهّز للعميل لينك "Save to Google
    // Wallet" فعلي. لو مش متظبط أو فشل، التسجيل نفسه بيعدّي عادي والعميل
    // لسه معاه الـ QR (memberCode) يورّيه للموظف
    let googleWalletUrl: string | null = null;
    const cfg = loadGoogleWalletConfig();
    if (cfg) {
      try {
        googleWalletUrl = await createGooglePassLink({
          cfg,
          baseUrl: publicBaseUrl(req),
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug ?? req.params.slug },
          customer,
        });
      } catch (walletErr: any) {
        console.error("[google-wallet] couldn't create pass link:", walletErr?.message ?? walletErr);
      }
    }

    // memberCode بيترجع هنا مرة واحدة بس، للشخص اللي لسه سجّل بنفسه
    res.status(201).json({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      balance: customer.balance,
      tier: customer.tier,
      memberCode: customer.memberCode,
      googleWalletUrl,
    });
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

  // الـ lookup عام (بالتليفون من غير حساب) - فمينفعش يرجّع memberCode
  // أبدًا، لأن أي حد يعرف رقم حد تاني كان هيقدر يسحب كوده ويستلم هديته
  res.json({
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    balance: customer.balance,
    tier: customer.tier,
    lastVisitAt: customer.lastVisitAt,
  });
});

// لوجو الشركة كصورة عامة - Google Wallet بيجيبها من الرابط ده. لو
// الشركة رافعة PNG/JPEG/GIF بنرجّعها، غير كده مربع بلون الشركة
publicWalletRouter.get("/:slug/logo.png", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).end();

  const settings = await getOrCreateWalletSettings(tenant.id);
  const match = settings.logoDataUrl ? /^data:(image\/(?:png|jpeg|gif));base64,(.+)$/s.exec(settings.logoDataUrl) : null;

  res.setHeader("Cache-Control", "public, max-age=300");
  if (match) {
    res.setHeader("Content-Type", match[1]);
    return res.send(Buffer.from(match[2], "base64"));
  }
  res.setHeader("Content-Type", "image/png");
  res.send(solidColorPng(settings.themeColor));
});
