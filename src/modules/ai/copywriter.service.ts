import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { GenerationStore } from "./ai-generation.repository";
import type { CopyBrief, CopyGenerator } from "./copy-generator";
import { AI_COSTS } from "./ai-pricing";

// سعر كل طلب كتابة بالنقاط (الطلب الواحد = لحد 3 نسخ) - من ai-pricing.ts
export const COPY_COST = AI_COSTS.copy;

// الكاتب الذكي: يتأكد من الرصيد ← يولّد ← يحفظ ← يخصم (الخصم بعد النجاح بس)
export class CopywriterService {
  constructor(
    private readonly generator: CopyGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore
  ) {}

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async write(tenantId: string, userId: string | null, brief: CopyBrief) {
    if (!this.generator) throw new ServiceUnavailableError("AI writing isn't set up yet — please contact support.");
    await this.credits.ensureCanSpend(tenantId, COPY_COST);
    const business = await this.generations.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const result = await this.generator.generate(brief, business);
    const saved = await this.generations.create({
      tenantId,
      userId,
      tool: "copywriter",
      kind: brief.kind,
      input: brief,
      output: result,
      creditsUsed: COPY_COST,
      model: this.generator.model,
    });
    const balance = await this.credits.spend({ tenantId, cost: COPY_COST, reason: "AI_COPY", userId, refId: saved.id });
    return { id: saved.id, variants: result.variants, creditsUsed: COPY_COST, balance };
  }

  history(tenantId: string) {
    return this.generations.recent(tenantId, "copywriter");
  }
}
