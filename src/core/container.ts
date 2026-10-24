import { prisma } from "../config/db";
import { CreditRepository } from "../modules/credits/credit.repository";
import { CreditService } from "../modules/credits/credit.service";
import { AiGenerationRepository } from "../modules/ai/ai-generation.repository";
import { makeCopyGenerator } from "../modules/ai/copy-generator.factory";
import { CopywriterService } from "../modules/ai/copywriter.service";

// المكان الوحيد اللي بيقرر "مين بيكلم مين" (Composition Root).
// الخدمات بتاخد اللي محتاجاه من برّه، فسهل نغيّر مزوّد أو نختبر بنسخة وهمية
const creditService = new CreditService(new CreditRepository(prisma));
const aiGenerations = new AiGenerationRepository(prisma);

export const container = {
  creditService,
  copywriterService: new CopywriterService(makeCopyGenerator(), creditService, aiGenerations),
};
