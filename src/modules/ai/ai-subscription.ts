import type { CreditMovement } from "../credits/credit.repository";

// اشتراك "استوديو الذكاء الاصطناعي" بيضيف نقاطه أول ما الطلب يتفعّل.
// العدد (الشهري / السنوي) بيتحدد من السوبر أدمن (platform_settings)
export interface AiCreditPlan {
  aiMonthlyCredits: number;
  aiYearlyCredits: number;
}

// اللي محتاجينه من سجل النقاط: إضافة حركة جوه transaction التفعيل نفسها
export interface CreditLedger<Tx> {
  apply(m: CreditMovement, tx?: Tx): Promise<number | null>;
}

export function includedAiCredits(billingCycle: string, plan: AiCreditPlan): number {
  return billingCycle === "yearly" ? plan.aiYearlyCredits : plan.aiMonthlyCredits;
}

// بيتنادى جوه نفس transaction تفعيل الطلب: يا الاتنين يحصلوا يا ولا واحد
// (قبل كده لو الإضافة فشلت بعد التفعيل النقاط كانت بتضيع). refId = رقم الطلب
export async function grantIncludedAiCredits<Tx>(ledger: CreditLedger<Tx>, tx: Tx, tenantId: string, billingCycle: string, orderId: string, plan: AiCreditPlan): Promise<number> {
  const amount = includedAiCredits(billingCycle, plan);
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  const after = await ledger.apply(
    { tenantId, amount, reason: "AI_SUBSCRIPTION", note: `AI Studio subscription (order ${orderId.slice(0, 8)})`, refId: orderId, createdById: null },
    tx
  );
  if (after === null) throw new Error(`Couldn't add the AI Studio credits for order ${orderId}`);
  return amount;
}
