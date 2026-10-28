// الإعلانات المدفوعة ("تمويل بوست"): العقود اللي الخدمة بتعتمد عليها (مش على Meta نفسها) + ونسخة وهمية للاختبارات

export const AD_OBJECTIVES = ["REACH", "ENGAGEMENT"] as const;
export type AdObjective = (typeof AD_OBJECTIVES)[number];

export const AD_GENDERS = ["all", "men", "women"] as const;
export type AdGender = (typeof AD_GENDERS)[number];

export interface AdCity {
  key: string;
  name: string;
}

// الجمهور: دول (أو مدن) + السن + النوع
export interface AdTargeting {
  countries: string[];
  cities: AdCity[];
  ageMin: number;
  ageMax: number;
  gender: AdGender;
}

export const AD_LIMITS = {
  // Meta بترفض أقل من كده تقريبًا (أقل ميزانية يومية) - بالدولار
  minDailyUsd: 1,
  ageMin: 18,
  ageMax: 65,
  maxCountries: 25,
  maxCities: 25,
  // إعلان "بيتعمل" من أقل من كده = نفس الضغطة اتبعتت مرتين
  duplicateWindowMs: 2 * 60 * 1000,
  // الأرقام (وصل لكام / صرف كام) بتتحدّث من Meta لو أقدم من كده
  refreshAfterMs: 10 * 60 * 1000,
} as const;

// حساب إعلانات عند Meta (act_123) - الفلوس بتتدفع منه بكارت التاجر
export interface AdAccountInfo {
  id: string; // act_123
  name: string;
  currency: string;
  // 1 = شغال. غير كده (موقوف / عليه فلوس / تحت المراجعة) مانعملش عليه إعلان
  active: boolean;
  statusText: string;
}

export interface BoostSpec {
  adAccountId: string;
  name: string;
  objective: AdObjective;
  platform: "FACEBOOK" | "INSTAGRAM";
  // صفحة فيسبوك (للانستجرام = الصفحة المربوطة بيه)
  pageId: string;
  instagramUserId: string | null;
  postExternalId: string;
  caption: string | null;
  // بأصغر وحدة للعملة (سنت / درهم) زي ما Meta عايزة
  dailyBudgetMinor: number;
  startAt: Date;
  endAt: Date;
  targeting: AdTargeting;
}

export interface BoostIds {
  campaignId: string;
  adSetId: string;
  creativeId: string;
  adId: string;
}

export interface AdState {
  // effective_status بتاع Meta زي ما هو (ACTIVE / PENDING_REVIEW / DISAPPROVED ...)
  metaStatus: string;
  reviewFeedback: string | null;
}

export interface AdInsights {
  impressions: number;
  reach: number;
  clicks: number;
  engagements: number;
  spend: number;
}

export interface AdsPlatform {
  listAdAccounts(userToken: string): Promise<AdAccountInfo[]>;
  searchCities(userToken: string, query: string): Promise<(AdCity & { country: string })[]>;
  // بيعمل الحملة كلها، ولو خطوة فشلت بيمسح اللي اتعمل (مفيش حاجة تفضل معلّقة عند Meta)
  createBoost(userToken: string, spec: BoostSpec): Promise<BoostIds>;
  setStatus(userToken: string, campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  setDailyBudget(userToken: string, adSetId: string, dailyBudgetMinor: number): Promise<void>;
  getState(userToken: string, adId: string): Promise<AdState>;
  getInsights(userToken: string, campaignId: string): Promise<AdInsights>;
}

// كل العملات اللي بنقبلها Meta بتحسبها بـ 100 وحدة صغيرة (سنت / درهم / فلس)
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

// حالتنا (اللي بتظهر للتاجر) من effective_status بتاع Meta
export function statusFromMeta(metaStatus: string, endAt: Date, now: Date): string {
  switch (metaStatus) {
    case "ACTIVE":
      return endAt <= now ? "COMPLETED" : "ACTIVE";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return endAt <= now ? "COMPLETED" : "PAUSED";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
    case "PREAPPROVED":
      return "PENDING_REVIEW";
    case "DISAPPROVED":
      return "REJECTED";
    case "WITH_ISSUES":
    case "PENDING_BILLING_INFO":
      return "ISSUE";
    case "ARCHIVED":
    case "DELETED":
      return "COMPLETED";
    default:
      return "PENDING_REVIEW";
  }
}
