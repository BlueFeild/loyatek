import { container } from "../../core/container";
import { getPlatformConfig } from "../../utils/platform-config";
import type { CreditService } from "./credit.service";

// نقاط التجربة: كل شركة جديدة بتاخد عدد نقاط ببلاش (السوبر أدمن بيحدده) تجرب بيها
// استوديو الذكاء الاصطناعي وقت التجربة. بتتسجل في سجل النقاط زي أي إضافة.
// فشلها مايوقفش إنشاء الشركة (السوبر أدمن يقدر يضيف النقاط بإيده)
export async function grantTrialCredits(credits: CreditService, tenantId: string, amount: number): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  try {
    await credits.grant(tenantId, amount, "system", "Free trial credits");
    return amount;
  } catch (err) {
    console.error(`[credits] couldn't add trial credits for ${tenantId}:`, err);
    return 0;
  }
}

// نفس اللي فوق بالعدد اللي في إعدادات المنصة - بيتنادى من كل أماكن إنشاء شركة جديدة
export async function giveNewCompanyTrialCredits(tenantId: string): Promise<number> {
  return grantTrialCredits(container.creditService, tenantId, (await getPlatformConfig()).defaultTrialCredits);
}
