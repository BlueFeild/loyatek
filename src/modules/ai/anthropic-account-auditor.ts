import Anthropic from "@anthropic-ai/sdk";
import { AppError, ServiceUnavailableError } from "../../core/errors";
import type { BusinessContext } from "./copy-generator";
import { AUDIT_OUTPUT_SCHEMA, parseAuditReport, type AccountAuditor, type AuditInput, type AuditMetrics, type AuditReport } from "./media-types";
import { AUDIT_SYSTEM, buildAuditPrompt } from "./media.prompts";

// تحليل الحساب باستخدام Claude (بيقرا السكرين شوت كمان). المفتاح ANTHROPIC_API_KEY في Railway بس
export class AnthropicAccountAuditor implements AccountAuditor {
  readonly model = "claude-opus-5-5";

  constructor(private readonly client: Anthropic = new Anthropic({ timeout: 180_000, maxRetries: 2 })) {}

  async audit(input: AuditInput, metrics: AuditMetrics, business: BusinessContext): Promise<AuditReport> {
    const images: Anthropic.Beta.BetaImageBlockParam[] = input.screenshots.map((s) => ({
      type: "image",
      source: { type: "base64", media_type: s.mimeType, data: s.base64 },
    }));
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: AUDIT_OUTPUT_SCHEMA } },
        system: AUDIT_SYSTEM,
        messages: [{ role: "user", content: [...images, { type: "text", text: buildAuditPrompt(input, metrics, business) }] }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        console.error("[ai] Anthropic rejected the key — check ANTHROPIC_API_KEY in Railway Variables");
        throw new ServiceUnavailableError("AI audit isn't set up yet — please contact support.");
      }
      if (err instanceof Anthropic.RateLimitError) throw new ServiceUnavailableError("The AI is busy right now — try again in a minute.");
      if (err instanceof Anthropic.APIConnectionError) throw new ServiceUnavailableError("Couldn't reach the AI service — please try again.");
      if (err instanceof Anthropic.APIError) {
        console.error(`[ai] Anthropic API error ${err.status}: ${err.message}`);
        throw new ServiceUnavailableError("The AI is not available right now — please try again.");
      }
      throw err;
    }
    if (response.stop_reason === "refusal") throw new AppError(422, "AI_REFUSED", "The AI couldn't analyse this account — please check the screenshots.");
    return parseAuditReport(response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
  }
}
