import type { CreditService } from "../credits/credit.service";
import { AI_MODULE_MONTHLY_CREDITS } from "./ai-pricing";

// اشتراك "استوديو الذكاء الاصطناعي" بيضيف نقاطه أول ما الطلب يتفعّل
// (الشهري = 100، السنوي = 12 × 100 مرة واحدة). فشل الإضافة مايوقفش تفعيل الاشتراك
export function includedAiCredits(billingCycle: string): number {
  return AI_MODULE_MONTHLY_CREDITS * (billingCycle === "yearly" ? 12 : 1);
}

export async function grantIncludedAiCredits(credits: CreditService, tenantId: string, billingCycle: string, orderId: string): Promise<number | null> {
  try {
    const amount = includedAiCredits(billingCycle);
    await credits.grant(tenantId, amount, "system", `AI Studio subscription (order ${orderId.slice(0, 8)})`);
    return amount;
  } catch (err) {
    console.error(`[ai] couldn't add the included credits for order ${orderId}:`, err);
    return null;
  }
}
