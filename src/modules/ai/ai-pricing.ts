// سعر كل أداة بالنقاط - المكان الوحيد اللي بيتحدد فيه (الشاشة بتقراه من الـ API)
export const AI_COSTS = {
  copy: 1, // كتابة (لحد 3 نسخ)
  image: 3, // صورة واحدة
  video: 20, // فيديو قصير
  audit: 5, // تقرير تحليل حساب واحد
} as const;

export type AiTool = keyof typeof AI_COSTS;

// الافتراضي لنقاط اشتراك "استوديو الذكاء الاصطناعي" في الشهر (السنوي = × 12) -
// السوبر أدمن بيغيّرهم (platform_settings.aiMonthlyCredits / aiYearlyCredits)
export const AI_MODULE_MONTHLY_CREDITS = 100;
