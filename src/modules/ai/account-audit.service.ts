import { randomUUID } from "crypto";
import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { GenerationStore } from "./ai-generation.repository";
import type { BusinessProfileReader } from "./business-profile.repository";
import { AI_COSTS } from "./ai-pricing";
import { computeAuditMetrics, type AccountAuditor, type AuditInput } from "./media-types";

// تحليل الحساب المدفوع: نخصم الأول ← الأرقام بنحسبها احنا ← الذكاء الاصطناعي يكتب التقرير ← نحفظ
// (لو حاجة فشلت النقاط بترجع). التحليل مبني على الأرقام والسكرين شوت اللي التاجر بيديهالنا
export class AccountAuditService {
  constructor(
    private readonly auditor: AccountAuditor | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly profiles: BusinessProfileReader
  ) {}

  get isAvailable(): boolean {
    return this.auditor !== null;
  }

  async run(tenantId: string, userId: string | null, input: AuditInput) {
    const auditor = this.auditor;
    if (!auditor) throw new ServiceUnavailableError("AI audits aren't set up yet — please contact support.");
    const business = await this.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const cost = AI_COSTS.audit;
    const id = randomUUID();
    const metrics = computeAuditMetrics(input);
    const { result: report, balance } = await this.credits.chargeFor({ tenantId, cost, reason: "AI_AUDIT", userId, refId: id }, async () => {
      const out = await auditor.audit(input, metrics, business);
      // السكرين شوت مابيتخزنش (حجمه كبير وبيانات خاصة) - بنسجل عددهم بس
      const { screenshots, ...rest } = input;
      await this.generations.create({
        id,
        tenantId,
        userId,
        tool: "audit",
        kind: input.platform,
        input: { ...rest, screenshotCount: screenshots.length },
        output: { report: out, metrics },
        creditsUsed: cost,
        model: auditor.model,
      });
      return out;
    });
    return { id, report, metrics, creditsUsed: cost, balance };
  }

  async get(tenantId: string, id: string) {
    const row = await this.generations.find(tenantId, id);
    if (!row || row.tool !== "audit") throw new NotFoundError("Report not found");
    return row;
  }

  history(tenantId: string) {
    return this.generations.recent(tenantId, "audit");
  }
}
