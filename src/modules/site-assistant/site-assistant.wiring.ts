import { getPlatformConfig, getRegionalPricing } from "../../utils/platform-config";
import { SMS_MONTHLY_INCLUDED } from "../sms/sms-subscription";
import { makeSiteAssistantModel } from "./site-assistant.models";
import { SiteAssistantService } from "./site-assistant.service";
import type { SiteFacts, SiteFactsSource } from "./site-assistant.types";

// الحقايق من نفس مصدر صفحة الأسعار (getRegionalPricing + getPlatformConfig) - مفيش أرقام ثابتة هنا
export class PlatformSiteFacts implements SiteFactsSource {
  async facts(country: string | null): Promise<SiteFacts> {
    const [pricing, config] = await Promise.all([getRegionalPricing(country), getPlatformConfig()]);
    const discounts: SiteFacts["discounts"] = {};
    for (const [m, d] of Object.entries(pricing.discounts)) discounts[m] = { pct: d.pct, endsAt: d.endsAt ? String(d.endsAt) : null };
    return {
      country: pricing.country,
      currency: pricing.currency,
      monthly: pricing.modulePrices,
      original: pricing.originalPrices,
      discounts,
      yearlyDiscountPct: Math.round(pricing.yearlyDiscount * 100),
      extraCompanyPrice: pricing.extraCompanyBasePrice,
      trialDays: config.defaultTrialDays,
      aiMonthlyCredits: config.aiMonthlyCredits,
      smsMonthlyIncluded: SMS_MONTHLY_INCLUDED,
    };
  }
}

// التوصيل هنا (زي promo.wiring.ts) عشان مانلمسش container.ts المشترك
export const siteAssistant = new SiteAssistantService(makeSiteAssistantModel(), new PlatformSiteFacts());
