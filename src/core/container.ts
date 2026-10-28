import { prisma } from "../config/db";
import { CreditRepository } from "../modules/credits/credit.repository";
import { CreditService } from "../modules/credits/credit.service";
import { TrialCreditsService } from "../modules/credits/trial-credits";
import { AiGenerationRepository } from "../modules/ai/ai-generation.repository";
import { AiAssetRepository } from "../modules/ai/ai-asset.repository";
import { PrismaBusinessProfileReader } from "../modules/ai/business-profile.repository";
import { makeAiProviders } from "../modules/ai/ai-providers.factory";
import { CopywriterService } from "../modules/ai/copywriter.service";
import { ImageStudioService } from "../modules/ai/image-studio.service";
import { VideoStudioService } from "../modules/ai/video-studio.service";
import { AccountAuditService } from "../modules/ai/account-audit.service";
import { MetaRatesService, PrismaMetaRatesStore } from "../modules/whatsapp/meta-rates.service";
import { PrismaCampaignRepository } from "../modules/whatsapp/campaign.repository";
import { MetaCampaignGateway } from "../modules/whatsapp/campaign-gateway";
import { CampaignSender } from "../modules/whatsapp/campaign-sender.service";
import { getPlatformConfig } from "../utils/platform-config";
import { PrismaSocialRepository } from "../modules/social/social.repository";
import { MetaSocialGateway } from "../modules/social/meta-social.gateway";
import { SocialAccountService } from "../modules/social/social-account.service";
import { SocialPostService } from "../modules/social/social-post.service";

// المكان الوحيد اللي بيقرر "مين بيكلم مين" (Composition Root).
// الخدمات بتاخد اللي محتاجاه من برّه، فسهل نغيّر مزوّد أو نختبر بنسخة وهمية
const creditRepository = new CreditRepository(prisma);
const creditService = new CreditService(creditRepository);
const generations = new AiGenerationRepository(prisma);
const assets = new AiAssetRepository(prisma);
const profiles = new PrismaBusinessProfileReader(prisma);
const providers = makeAiProviders();
const socialStore = new PrismaSocialRepository(prisma);
const metaSocial = new MetaSocialGateway();

// عنوان الباك إند العام: فيسبوك/انستجرام بيجيبوا صورة البوست منه (Railway بيدّي RAILWAY_PUBLIC_DOMAIN لوحده)
function publicApiBaseUrl(): string {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  return `http://localhost:${process.env.PORT || 4000}`;
}

export const container = {
  creditService,
  // لإضافة نقاط جوه transaction تانية (تفعيل اشتراك)
  creditLedger: creditRepository,
  trialCreditsService: new TrialCreditsService(creditService, async () => (await getPlatformConfig()).defaultTrialCredits),
  aiAssets: assets,
  copywriterService: new CopywriterService(providers.copy, creditService, generations, profiles),
  imageStudioService: new ImageStudioService(providers.image, creditService, generations, assets, profiles),
  videoStudioService: new VideoStudioService(providers.video, creditService, generations, assets, profiles),
  accountAuditService: new AccountAuditService(providers.auditor, creditService, generations, profiles),
  metaRatesService: new MetaRatesService(new PrismaMetaRatesStore(prisma)),
  campaignSender: new CampaignSender(new PrismaCampaignRepository(prisma), new MetaCampaignGateway()),
  socialAccountService: new SocialAccountService(socialStore, metaSocial),
  socialPostService: new SocialPostService(socialStore, metaSocial, publicApiBaseUrl),
};
