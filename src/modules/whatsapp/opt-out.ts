import { normalizeForMatch } from "./bot";

// إلغاء الاشتراك (Opt-out): Meta بتطلب إن العميل يقدر يوقف الرسايل الترويجية.
// بنعتبرها طلب بس لو الرسالة كلها هي الكلمة (عشان "مش عايز إلغاء الحجز" ماتتحسبش)
const OPT_OUT = ["stop", "stop all", "stopall", "unsubscribe", "opt out", "optout", "الغاء", "الغاء الاشتراك", "ايقاف", "ايقاف الرسائل", "وقف", "stop promotions"];
const OPT_IN = ["start", "subscribe", "unstop", "opt in", "اشتراك", "تفعيل", "اشتراك مره اخري", "تفعيل الاشتراك"];

const OUT_SET = new Set(OPT_OUT.map(normalizeForMatch));
const IN_SET = new Set(OPT_IN.map(normalizeForMatch));

export type OptIntent = "OUT" | "IN" | null;

export function optIntent(text: string): OptIntent {
  const t = normalizeForMatch(text);
  if (!t) return null;
  if (OUT_SET.has(t)) return "OUT";
  if (IN_SET.has(t)) return "IN";
  return null;
}

// الرد اللي بيتبعت للعميل (عربي + إنجليزي) - جوه نافذة الـ24 ساعة لأنه لسه باعت
export const OPT_REPLIES: Record<"OUT" | "IN", string> = {
  OUT: "تم إيقاف الرسائل الترويجية ✅ لو حبيت ترجع، ابعت: اشتراك\nYou've been unsubscribed from promotional messages. Reply START to subscribe again.",
  IN: "تم تفعيل اشتراكك من جديد ✅\nYou're subscribed again. Reply STOP any time to unsubscribe.",
};
