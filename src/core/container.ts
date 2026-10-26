import { prisma } from "../config/db";
import { CreditRepository } from "../modules/credits/credit.repository";
import { CreditService } from "../modules/credits/credit.service";
import { AiGenerationRepository } from "../modules/ai/ai-generation.repository";
import { AiAssetRepository } from "../modules/ai/ai-asset.repository";
import { makeAiProviders } from "../modules/ai/copy-generator.factory";
import { CopywriterService } from "../modules/ai/copywriter.service";
import { ImageStudioService } from "../modules/ai/image-studio.service";
import { VideoStudioService } from "../modules/ai/video-studio.service";
import { AccountAuditService } from "../modules/ai/account-audit.service";
import { MetaRatesService, PrismaMetaRatesStore } from "../modules/whatsapp/meta-rates.service";

// المكان الوحيد اللي بيقرر "مين بيكلم مين" (Composition Root).
// الخدمات بتاخد اللي محتاجاه من برّه، فسهل نغيّر مزوّد أو نختبر بنسخة وهمية
const creditService = new CreditService(new CreditRepository(prisma));
const generations = new AiGenerationRepository(prisma);
const assets = new AiAssetRepository(prisma);
const providers = makeAiProviders();

export const container = {
  creditService,
  aiAssets: assets,
  copywriterService: new CopywriterService(providers.copy, creditService, generations),
  imageStudioService: new ImageStudioService(providers.image, creditService, generations, assets),
  videoStudioService: new VideoStudioService(providers.video, creditService, generations, assets),
  accountAuditService: new AccountAuditService(providers.auditor, creditService, generations),
  metaRatesService: new MetaRatesService(new PrismaMetaRatesStore(prisma)),
};
