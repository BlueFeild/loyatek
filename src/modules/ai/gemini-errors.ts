import { AppError, ServiceUnavailableError } from "../../core/errors";
import { geminiStatus } from "./gemini-client";

// ترجمة أخطاء جوجل لرسايل مفهومة للتاجر (من غير ما نسرّب تفاصيل المفتاح)
export function translateGeminiError(err: unknown, what: string): Error {
  if (err instanceof AppError) return err;
  const status = geminiStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 429) {
    return new ServiceUnavailableError(`The AI ${what} limit was reached — try again in a minute (free plans have low limits).`);
  }
  if (status === 400 && /billing|paid|quota|free tier/i.test(message)) {
    console.error(`[ai] Gemini ${what}: needs a paid plan — ${message}`);
    return new ServiceUnavailableError(`AI ${what} needs billing enabled on the Google AI account — please contact support.`);
  }
  if (status === 400 && /safety|blocked|policy/i.test(message)) {
    return new AppError(422, "AI_REFUSED", `The AI couldn't make this ${what} — please change the description.`);
  }
  if (status === 401 || status === 403 || status === 404 || status === 400) {
    console.error(`[ai] Gemini ${what} rejected (${status}): ${message} — check GEMINI_API_KEY / model name / billing`);
    return new ServiceUnavailableError(`AI ${what} isn't set up yet — please contact support.`);
  }
  if (status >= 500) {
    // 503 = "high demand" عند جوجل (بيحصل كتير في الباقة المجانية) - مؤقت
    console.error(`[ai] Gemini ${what} server error ${status}: ${message}`);
    return new ServiceUnavailableError("Google's AI is very busy right now — please try again in a minute (you were not charged).");
  }
  console.error(`[ai] Gemini ${what} call failed:`, err);
  return new ServiceUnavailableError("Couldn't reach the AI service — please try again.");
}
