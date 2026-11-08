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
import { AccountAuditService, PrismaAuditPlan } from "../modules/ai/account-audit.service";
import { MetaRatesService, PrismaMetaRatesStore } from "../modules/whatsapp/meta-rates.service";
import { PrismaCampaignRepository } from "../modules/whatsapp/campaign.repository";
import { MetaCampaignGateway } from "../modules/whatsapp/campaign-gateway";
import { CampaignSender } from "../modules/whatsapp/campaign-sender.service";
import { ContactBookService } from "../modules/whatsapp/contact-book.service";
import { CommentAutomationService } from "../modules/social/comment-automation.service";
import { PrismaCommentRuleRepository } from "../modules/social/comment-rules.repository";
import { AiAgentService } from "../modules/whatsapp/ai-agent.service";
import { MetaAgentMessenger, PrismaAiAgentRepository } from "../modules/whatsapp/ai-agent.repository";
import { PrismaAgentBooker } from "../modules/whatsapp/agent-booking";
import { FlowService } from "../modules/whatsapp/flow.service";
import { WhatsappNumbersService } from "../modules/whatsapp/whatsapp-numbers.service";
import { MetaFlowMessenger, PrismaFlowRepository } from "../modules/whatsapp/flow.repository";
import { PrismaContactBookRepository } from "../modules/whatsapp/contact-book.repository";
import { getConversationContacts, getUnifiedContacts } from "../modules/whatsapp/whatsapp.service";
import { getPlatformConfig } from "../utils/platform-config";
import { PrismaSocialRepository } from "../modules/social/social.repository";
import { MetaSocialGateway } from "../modules/social/meta-social.gateway";
import { SocialAccountService } from "../modules/social/social-account.service";
import { SocialPostService } from "../modules/social/social-post.service";
import { PrismaInboxRepository } from "../modules/social/social-inbox.repository";
import { SocialInboxService } from "../modules/social/social-inbox.service";
import { TikTokGateway } from "../modules/social/tiktok.gateway";
import { RoutingPublisher, SocialTokenService } from "../modules/social/social-token.service";
import { PrismaAdsRepository } from "../modules/social/ads.repository";
import { MetaAdsGateway } from "../modules/social/meta-ads.gateway";
import { SocialAdsService } from "../modules/social/ads.service";
import { getRates } from "../utils/money";
import { sendEmail } from "../utils/email";
import { PrismaPlannerRepository } from "../modules/social/social-planner.repository";
import { SocialPlannerService } from "../modules/social/social-planner.service";
import { BlueskyGateway } from "../modules/social/bluesky.gateway";
import { PrismaSocialFlowStore, SocialFlowService } from "../modules/social/social-flow.service";
import { PrismaReportRepository } from "../modules/social/social-report.repository";
import { SocialReportService } from "../modules/social/social-report.service";
import { PrismaIntegrationsRepository } from "../modules/integrations/integrations.repository";
import { IntegrationsService } from "../modules/integrations/integrations.service";
import { setEventSink } from "../modules/integrations/events";

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
const tiktok = new TikTokGateway();
const socialTokens = new SocialTokenService(socialStore, { TIKTOK: tiktok });
const bluesky = new BlueskyGateway();
const socialPublisher = new RoutingPublisher({ FACEBOOK: metaSocial, INSTAGRAM: metaSocial, TIKTOK: tiktok, BLUESKY: bluesky });
const socialAdsService = new SocialAdsService(new PrismaAdsRepository(prisma), new MetaAdsGateway(), {
  limits: async () => {
    const c = await getPlatformConfig();
    return { maxDailyBudgetUsd: c.adsMaxDailyBudgetUsd, maxDays: c.adsMaxDays };
  },
  rates: getRates,
  publicMediaUrl: (key) => `${publicApiBaseUrl()}/api/public/social/media/${key}`,
  whatsappReady: async (tenantId) => Boolean((await prisma.whatsappSettings.findUnique({ where: { tenantId }, select: { isConnected: true } }))?.isConnected),
});
const frontendBaseUrl = () => (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");

// عنوان الباك إند العام: فيسبوك/انستجرام بيجيبوا صورة البوست منه (Railway بيدّي RAILWAY_PUBLIC_DOMAIN لوحده)
function publicApiBaseUrl(): string {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway}`;
  return `http://localhost:${process.env.PORT || 4000}`;
}

const whatsappNumbers = new WhatsappNumbersService(prisma);

// Webhooks خارجية + مفاتيح API: أي جزء في السيستم بيبعت حدث عن طريق emitEvent()
const integrationsService = new IntegrationsService(new PrismaIntegrationsRepository(prisma));
setEventSink((tenantId, type, data) => integrationsService.emit(tenantId, type, data));

// الكالندر / التكرار / موافقة العميل
const socialPlanner = new SocialPlannerService(new PrismaPlannerRepository(prisma), {
  frontendBaseUrl,
  publicMediaUrl: (key) => `${publicApiBaseUrl()}/api/public/social/media/${key}`,
  sendEmail,
});
const socialPostService = new SocialPostService(socialStore, socialPublisher, publicApiBaseUrl, undefined, socialTokens, {
  afterPublish: async (p) => {
    await socialPlanner.afterPublish(p);
    const view = await socialStore.getPost(p.tenantId, p.id);
    if (view) {
      integrationsService.emit(p.tenantId, p.status === "FAILED" ? "post.failed" : "post.published", {
        id: view.id,
        status: view.status,
        caption: view.caption,
        publishedAt: view.publishedAt,
        targets: view.targets.map((t) => ({ platform: t.platform, account: t.accountName, status: t.status, permalink: t.permalink, error: t.error })),
      });
    }
  },
});
const inboxRepository = new PrismaInboxRepository(prisma);
const flowRepository = new PrismaFlowRepository(prisma);
const socialFlowService = new SocialFlowService(new PrismaSocialFlowStore(prisma, flowRepository), metaSocial, inboxRepository);
const commentAutomation = new CommentAutomationService(new PrismaCommentRuleRepository(prisma), metaSocial);

export const container = {
  creditService,
  // لإضافة نقاط جوه transaction تانية (تفعيل اشتراك)
  creditLedger: creditRepository,
  trialCreditsService: new TrialCreditsService(creditService, async () => (await getPlatformConfig()).defaultTrialCredits),
  aiAssets: assets,
  copywriterService: new CopywriterService(providers.copy, creditService, generations, profiles),
  imageStudioService: new ImageStudioService(providers.image, creditService, generations, assets, profiles),
  videoStudioService: new VideoStudioService(providers.video, creditService, generations, assets, profiles),
  accountAuditService: new AccountAuditService(providers.auditor, new PrismaAuditPlan(prisma), generations, profiles),
  metaRatesService: new MetaRatesService(new PrismaMetaRatesStore(prisma)),
  campaignSender: new CampaignSender(new PrismaCampaignRepository(prisma), new MetaCampaignGateway()),
  contactBookService: new ContactBookService(new PrismaContactBookRepository(prisma), { customers: async (tenantId: string) => [...(await getUnifiedContacts(tenantId)), ...(await getConversationContacts(tenantId))] }),
  whatsappNumbers,
  flowService: new FlowService(flowRepository, new MetaFlowMessenger(whatsappNumbers)),
  aiAgentService: new AiAgentService(new PrismaAiAgentRepository(prisma), new MetaAgentMessenger(whatsappNumbers), providers.agent, creditService, new PrismaAgentBooker(prisma)),
  socialAccountService: new SocialAccountService(socialStore, metaSocial, { tiktok, tokens: socialTokens, publicApiBaseUrl, frontendBaseUrl, adsAuth: socialAdsService, bluesky }),
  socialPostService,
  socialPlanner,
  socialReportService: new SocialReportService(new PrismaReportRepository(prisma), { frontendBaseUrl, sendEmail }),
  integrationsService,
  socialAdsService,
  socialInboxService: new SocialInboxService(inboxRepository, metaSocial, { generator: providers.copy, credits: creditService, generations, profiles }, undefined, commentAutomation, socialFlowService),
  commentAutomation,
};
