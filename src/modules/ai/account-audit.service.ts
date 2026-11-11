import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { AppError, NotFoundError, ServiceUnavailableError } from "../../core/errors";
import { getRealActiveModules, isTrialActive } from "../../utils/modules";
import { tenantGraceDays } from "../../utils/platform-config";
import type { GenerationStore } from "./ai-generation.repository";
import type { BusinessProfileReader } from "./business-profile.repository";
import { AUDIT_MONTHLY_LIMITS } from "./ai-pricing";
import { computeAuditMetrics, type AccountAuditor, type AuditInput } from "./media-types";

// كام تقرير مسموح للشركة في الشهر؟ null = من غير حد (شركة صاحب المنصة)
export interface AuditPlan {
  monthlyLimit(tenantId: string): Promise<number | null>;
}

export class PrismaAuditPlan implements AuditPlan {
  constructor(private readonly db: PrismaClient) {}

  async monthlyLimit(tenantId: string): Promise<number | null> {
    const tenant = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { subscribedModules: true, moduleExpirations: true, trialExpiresAt: true, isPlatformOwner: true, accountStatus: true, graceDays: true },
    });
    if (!tenant) return 0;
    if (tenant.isPlatformOwner) return null;
    if (getRealActiveModules(tenant, new Date(), await tenantGraceDays(tenant)).includes("social")) return AUDIT_MONTHLY_LIMITS.subscribed;
    return isTrialActive(tenant) ? AUDIT_MONTHLY_LIMITS.trial : 0;
  }
}

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// تحليل الحساب: اشتراك شهري بعدد تقارير (التقرير الفاشل مابيتحسبش لأنه بيتسجل بعد النجاح).
// الأرقام بنحسبها احنا والذكاء الاصطناعي يكتب التقرير من الأرقام والسكرين شوت اللي التاجر بيديهالنا
export class AccountAuditService {
  constructor(
    private readonly auditor: AccountAuditor | null,
    private readonly plan: AuditPlan,
    private readonly generations: GenerationStore,
    private readonly profiles: BusinessProfileReader
  ) {}

  get isAvailable(): boolean {
    return this.auditor !== null;
  }

  async usage(tenantId: string, now: Date = new Date()) {
    const [used, limit] = await Promise.all([this.generations.countSince(tenantId, "audit", monthStart(now)), this.plan.monthlyLimit(tenantId)]);
    return { available: this.isAvailable, used, limit };
  }

  async run(tenantId: string, userId: string | null, input: AuditInput) {
    const auditor = this.auditor;
    if (!auditor) throw new ServiceUnavailableError("AI audits aren't set up yet — please contact support.");
    const business = await this.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const { used, limit } = await this.usage(tenantId);
    if (limit !== null && used >= limit) throw new AppError(429, "AUDIT_LIMIT", `You've used all ${limit} audit reports for this month. More become available next month.`);

    const id = randomUUID();
    const metrics = computeAuditMetrics(input);
    const report = await auditor.audit(input, metrics, business);
    // السكرين شوت مابيتخزنش (حجمه كبير وبيانات خاصة) - بنسجل عددهم بس
    const { screenshots, ...rest } = input;
    await this.generations.create({
      id,
      tenantId,
      userId,
      tool: "audit",
      kind: input.platform,
      input: { ...rest, screenshotCount: screenshots.length },
      output: { report, metrics },
      creditsUsed: 0,
      model: auditor.model,
    });
    return { id, report, metrics, used: used + 1, limit };
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
