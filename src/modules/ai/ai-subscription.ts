import type { CreditService } from "../credits/credit.service";

// اشتراك "استوديو الذكاء الاصطناعي" بيضيف نقاطه أول ما الطلب يتفعّل.
// العدد (الشهري / السنوي) بيتحدد من السوبر أدمن (platform_settings) - فشل الإضافة مايوقفش التفعيل
export interface AiCreditPlan {
  aiMonthlyCredits: number;
  aiYearlyCredits: number;
}

export function includedAiCredits(billingCycle: string, plan: AiCreditPlan): number {
  return billingCycle === "yearly" ? plan.aiYearlyCredits : plan.aiMonthlyCredits;
}

export async function grantIncludedAiCredits(credits: CreditService, tenantId: string, billingCycle: string, orderId: string, plan: AiCreditPlan): Promise<number | null> {
  const amount = includedAiCredits(billingCycle, plan);
  if (amount <= 0) return 0;
  try {
    await credits.grant(tenantId, amount, "system", `AI Studio subscription (order ${orderId.slice(0, 8)})`);
    return amount;
  } catch (err) {
    console.error(`[ai] couldn't add the included credits for order ${orderId}:`, err);
    return null;
  }
}
