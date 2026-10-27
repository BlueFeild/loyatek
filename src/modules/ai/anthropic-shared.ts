import Anthropic from "@anthropic-ai/sdk";
import { AppError, ServiceUnavailableError } from "../../core/errors";

// مودل Claude: من ANTHROPIC_MODEL في Railway لو اتحط، غير كده الافتراضي (مكان واحد بس)
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export function anthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
}

// ترجمة أخطاء Anthropic لرسايل مفهومة للتاجر (من غير تفاصيل المفتاح). what = "writing" / "audit"
export function translateAnthropicError(err: unknown, what: string): Error {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    console.error("[ai] Anthropic rejected the key — check ANTHROPIC_API_KEY in Railway Variables");
    return new ServiceUnavailableError(`AI ${what} isn't set up yet — please contact support.`);
  }
  if (err instanceof Anthropic.RateLimitError) return new ServiceUnavailableError("The AI is busy right now — try again in a minute.");
  if (err instanceof Anthropic.APIConnectionError) return new ServiceUnavailableError("Couldn't reach the AI service — please try again.");
  if (err instanceof Anthropic.APIError) {
    console.error(`[ai] Anthropic API error ${err.status}: ${err.message}`);
    return new ServiceUnavailableError("The AI is not available right now — please try again.");
  }
  return err instanceof Error ? err : new Error(String(err));
}

// النص اللي رجع من Claude (كل بلوكات النص ورا بعض)
export function responseText(response: Anthropic.Beta.BetaMessage): string {
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}
