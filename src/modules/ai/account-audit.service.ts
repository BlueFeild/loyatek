import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { GenerationStore } from "./ai-generation.repository";
import { AI_COSTS } from "./ai-pricing";
import { computeAuditMetrics, type AccountAuditor, type AuditInput } from "./media-types";

// تحليل الحساب المدفوع: الأرقام بنحسبها احنا ← الذكاء الاصطناعي يكتب التقرير ← نحفظ ← نخصم (بعد النجاح بس).
// التحليل مبني على الأرقام والسكرين شوت اللي التاجر بيديهالنا (مش سحب مباشر من المنصة)
export class AccountAuditService {
  constructor(
    private readonly auditor: AccountAuditor | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore
  ) {}

  get isAvailable(): boolean {
    return this.auditor !== null;
  }

  async run(tenantId: string, userId: string | null, input: AuditInput) {
    if (!this.auditor) throw new ServiceUnavailableError("AI audits aren't set up yet — please contact support.");
    const cost = AI_COSTS.audit;
    await this.credits.ensureCanSpend(tenantId, cost);
    const business = await this.generations.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const metrics = computeAuditMetrics(input);
    const report = await this.auditor.audit(input, metrics, business);
    // السكرين شوت مابيتخزنش (حجمه كبير وبيانات خاصة) - بنسجل عددهم بس
    const { screenshots, ...rest } = input;
    const saved = await this.generations.create({
      tenantId,
      userId,
      tool: "audit",
      kind: input.platform,
      input: { ...rest, screenshotCount: screenshots.length },
      output: { report, metrics },
      creditsUsed: cost,
      model: this.auditor.model,
    });
    const balance = await this.credits.spend({ tenantId, cost, reason: "AI_AUDIT", userId, refId: saved.id });
    return { id: saved.id, report, metrics, creditsUsed: cost, balance };
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
