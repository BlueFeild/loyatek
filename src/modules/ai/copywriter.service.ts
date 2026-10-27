import { randomUUID } from "crypto";
import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { GenerationStore } from "./ai-generation.repository";
import type { BusinessProfileReader } from "./business-profile.repository";
import type { CopyBrief, CopyGenerator } from "./copy-generator";
import { AI_COSTS } from "./ai-pricing";

// سعر كل طلب كتابة بالنقاط (الطلب الواحد = لحد 3 نسخ) - من ai-pricing.ts
export const COPY_COST = AI_COSTS.copy;

// الكاتب الذكي: يخصم الأول ← يولّد ← يحفظ (لو حاجة فشلت النقاط بترجع)
export class CopywriterService {
  constructor(
    private readonly generator: CopyGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly profiles: BusinessProfileReader
  ) {}

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async write(tenantId: string, userId: string | null, brief: CopyBrief) {
    const generator = this.generator;
    if (!generator) throw new ServiceUnavailableError("AI writing isn't set up yet — please contact support.");
    const business = await this.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const id = randomUUID();
    const { result, balance } = await this.credits.chargeFor({ tenantId, cost: COPY_COST, reason: "AI_COPY", userId, refId: id }, async () => {
      const out = await generator.generate(brief, business);
      await this.generations.create({ id, tenantId, userId, tool: "copywriter", kind: brief.kind, input: brief, output: out, creditsUsed: COPY_COST, model: generator.model });
      return out;
    });
    return { id, variants: result.variants, creditsUsed: COPY_COST, balance };
  }

  history(tenantId: string) {
    return this.generations.recent(tenantId, "copywriter");
  }
}
