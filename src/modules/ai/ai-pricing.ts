// سعر كل أداة بالنقاط - المكان الوحيد اللي بيتحدد فيه (الشاشة بتقراه من الـ API)
export const AI_COSTS = {
  copy: 1, // كتابة (لحد 3 نسخ)
  image: 3, // صورة واحدة
  video: 20, // فيديو قصير
  audit: 5, // تقرير تحليل حساب واحد
} as const;

export type AiTool = keyof typeof AI_COSTS;

// حدود الأدوات (الفيديو بيشتغل في الخلفية) - في مكان واحد جنب الأسعار
export const AI_LIMITS = {
  // أقصى وقت لمزوّد الفيديو - بعده العملية تفشل والنقاط ترجع (لازم أقل من videoStaleAfterMs)
  videoTimeoutMs: 10 * 60_000,
  // فيديو فضل PENDING أكتر من كده ومش شغال في السيرفر ده (اتعاد تشغيله) ← FAILED ونرجّع النقاط
  videoStaleAfterMs: 20 * 60_000,
  // أقصى عدد فيديوهات شغالة لنفس الشركة في نفس الوقت
  maxRunningVideosPerCompany: 2,
  // الشاشة بتسأل عن حالة الفيديو كل كام ثانية
  videoPollMs: 5_000,
} as const;

export type VideoLimits = { timeoutMs: number; staleAfterMs: number; maxRunning: number };

// الافتراضي لنقاط اشتراك "استوديو الذكاء الاصطناعي" في الشهر (السنوي = × 12) -
// السوبر أدمن بيغيّرهم (platform_settings.aiMonthlyCredits / aiYearlyCredits)
export const AI_MODULE_MONTHLY_CREDITS = 100;
