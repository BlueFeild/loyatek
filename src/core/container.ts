import { prisma } from "../config/db";
import { CreditRepository } from "../modules/credits/credit.repository";
import { CreditService } from "../modules/credits/credit.service";
import { AiGenerationRepository } from "../modules/ai/ai-generation.repository";
import { AnthropicCopyGenerator } from "../modules/ai/anthropic-copy-generator";
import { FakeCopyGenerator } from "../modules/ai/fake-copy-generator";
import type { CopyGenerator } from "../modules/ai/copy-generator";
import { CopywriterService } from "../modules/ai/copywriter.service";

// المكان الوحيد اللي بيقرر "مين بيكلم مين" (Composition Root).
// الخدمات بتاخد اللي محتاجاه من برّه، فسهل نغيّر مزوّد أو نختبر بنسخة وهمية

// AI_PROVIDER=fake للتجارب المحلية؛ غير كده Claude لو ANTHROPIC_API_KEY موجود
function makeCopyGenerator(): CopyGenerator | null {
  const provider = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "fake") return new FakeCopyGenerator();
  if (process.env.ANTHROPIC_API_KEY?.trim()) return new AnthropicCopyGenerator();
  return null;
}

const creditService = new CreditService(new CreditRepository(prisma));
const aiGenerations = new AiGenerationRepository(prisma);

export const container = {
  creditService,
  copywriterService: new CopywriterService(makeCopyGenerator(), creditService, aiGenerations),
};
