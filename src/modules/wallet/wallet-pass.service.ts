import type { Request } from "express";
import { prisma } from "../../config/db";
import { getOrCreateWalletSettings } from "./wallet.service";
import {
  GoogleRequester,
  GoogleWalletConfig,
  PassMessage,
  buildLoyaltyClass,
  buildLoyaltyObject,
  buildLoyaltyObjectState,
  buildSaveToWalletUrl,
  createGoogleRequester,
  ensureLoyaltyClass,
  loadGoogleWalletConfig,
  objectIdFor,
  patchLoyaltyObjectState,
  upsertLoyaltyObject,
} from "./google-wallet.service";

// الغراء بين الداتابيز وGoogle Wallet: بيجهّز بيانات العميل ويبعتها

let cachedRequester: { key: string; requester: GoogleRequester } | null = null;
function getRequester(cfg: GoogleWalletConfig): GoogleRequester {
  const key = `${cfg.issuerId}:${cfg.clientEmail}`;
  if (!cachedRequester || cachedRequester.key !== key) {
    cachedRequester = { key, requester: createGoogleRequester(cfg) };
  }
  return cachedRequester.requester;
}

// عنوان الباك إند العام - Google لازم يقدر يفتح لينك اللوجو من النت.
// الأفضل تحددي PUBLIC_API_BASE_URL في Railway، ولو مش موجود بنستنتجه
// من الـ request نفسه
export function publicBaseUrl(req: Request) {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0];
  return `${proto}://${req.get("host")}`;
}

// بيعمل (أو بيحدّث) Class الشركة وObject العميل عند Google، وبيرجّع
// لينك "Save to Google Wallet". أي فشل بيترمي ويتعامل معاه اللي نادى
export async function createGooglePassLink(args: {
  cfg: GoogleWalletConfig;
  baseUrl: string;
  tenant: { id: string; name: string; slug: string };
  customer: { id: string; name: string; phone: string; memberCode: string; balance: number };
}) {
  const { cfg, baseUrl, tenant, customer } = args;
  const settings = await getOrCreateWalletSettings(tenant.id);
  const availableRewards = await prisma.walletReward.count({ where: { customerId: customer.id, status: "AVAILABLE" } });
  const requester = getRequester(cfg);

  await ensureLoyaltyClass(
    requester,
    buildLoyaltyClass({
      issuerId: cfg.issuerId,
      tenantId: tenant.id,
      tenantName: tenant.name,
      themeColor: settings.themeColor,
      logoUrl: `${baseUrl}/api/public/wallet/${tenant.slug}/logo.png`,
    })
  );

  await upsertLoyaltyObject(
    requester,
    buildLoyaltyObject({
      issuerId: cfg.issuerId,
      tenantId: tenant.id,
      customer,
      stampCount: settings.stampCount,
      rewardText: settings.rewardText,
      availableRewards,
    })
  );

  return buildSaveToWalletUrl(cfg, objectIdFor(cfg, customer.id));
}

async function syncPass(customerId: string, message?: PassMessage) {
  const cfg = loadGoogleWalletConfig();
  if (!cfg) return;

  const customer = await prisma.walletCustomer.findUnique({ where: { id: customerId } });
  if (!customer) return;

  const settings = await getOrCreateWalletSettings(customer.tenantId);
  const availableRewards = await prisma.walletReward.count({ where: { customerId, status: "AVAILABLE" } });

  await patchLoyaltyObjectState(
    getRequester(cfg),
    objectIdFor(cfg, customerId),
    buildLoyaltyObjectState({
      balance: customer.balance,
      stampCount: settings.stampCount,
      rewardText: settings.rewardText,
      availableRewards,
      message,
    })
  );
}

// تحديث الكارت على موبايل العميل بعد أي تغيير (ختم/هدية/تسليم). بيشتغل
// في الخلفية ومبيعطّلش رد الموظف، وفشله (إنترنت Google مثلًا) مش بيكسر
// عملية الختم الحقيقية اللي اتسجّلت في الداتابيز بالفعل
export function queuePassSync(customerId: string, message?: PassMessage) {
  syncPass(customerId, message).catch((err) => {
    console.error("[google-wallet] pass sync failed:", err?.message ?? err);
  });
}
