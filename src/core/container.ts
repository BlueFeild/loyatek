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

// المكان الوحيد اللي بيقرر "مين بيكلم مين" (Composition Root).
// الخدمات بتاخد اللي محتاجاه من برّه، فسهل نغيّر مزوّد أو نختبر بنسخة وهمية
const creditRepository = new CreditRepository(prisma);
const creditService = new CreditService(creditRepository);
const generations = new AiGenerationRepository(prisma);
const assets = new AiAssetRepository(prisma);
const profiles = new PrismaBusinessProfileReader(prisma);
const providers = makeAiProviders();

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
};
