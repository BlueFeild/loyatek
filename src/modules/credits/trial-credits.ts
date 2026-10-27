import type { CreditService } from "./credit.service";

// نقاط التجربة: كل شركة جديدة بتاخد عدد نقاط ببلاش (السوبر أدمن بيحدده) تجرب بيها
// استوديو الذكاء الاصطناعي وقت التجربة. بتتسجل في سجل النقاط (TRIAL، من النظام مش يوزر).
// فشلها مايوقفش إنشاء الشركة (السوبر أدمن يقدر يضيف النقاط بإيده)
export class TrialCreditsService {
  constructor(
    private readonly credits: CreditService,
    // عدد النقاط من إعدادات المنصة (بيتقري وقت الإنشاء عشان أي تغيير يسري على طول)
    private readonly trialAmount: () => Promise<number>
  ) {}

  async grant(tenantId: string, amount: number): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) return 0;
    try {
      await this.credits.grant(tenantId, amount, null, "Free trial credits", "TRIAL");
      return amount;
    } catch (err) {
      console.error(`[credits] couldn't add trial credits for ${tenantId}:`, err);
      return 0;
    }
  }

  // بيتنادى من كل أماكن إنشاء شركة جديدة
  async giveNewCompany(tenantId: string): Promise<number> {
    let amount = 0;
    try {
      amount = await this.trialAmount();
    } catch (err) {
      console.error("[credits] couldn't read the trial credits setting:", err);
    }
    return this.grant(tenantId, amount);
  }
}
