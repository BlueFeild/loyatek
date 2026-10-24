import Anthropic from "@anthropic-ai/sdk";
import { AppError, ServiceUnavailableError } from "../../core/errors";
import { copyResultSchema, type BusinessContext, type CopyBrief, type CopyGenerator, type CopyResult } from "./copy-generator";
import { buildCopyPrompt, COPYWRITER_SYSTEM } from "./copywriter.prompts";

// شكل الرد المطلوب من Claude (structured output) - وبنتأكد منه تاني بـ zod
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, hashtags: { type: "array", items: { type: "string" } } },
        required: ["text", "hashtags"],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
};

const UNEXPECTED = "The AI returned an unexpected answer — please try again.";

// تطبيق CopyGenerator باستخدام Claude. المفتاح ANTHROPIC_API_KEY في Railway Variables بس
export class AnthropicCopyGenerator implements CopyGenerator {
  readonly model = "claude-opus-5-5";

  constructor(private readonly client: Anthropic = new Anthropic({ timeout: 90_000, maxRetries: 2 })) {}

  async generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // لو المودل رفض لسبب أمان، Anthropic بتعيد الطلب على البديل المناسب تلقائي
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        system: COPYWRITER_SYSTEM,
        messages: [{ role: "user", content: buildCopyPrompt(brief, business) }],
      });
    } catch (err) {
      throw this.translateError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new AppError(422, "AI_REFUSED", "The AI couldn't write this one — please rephrase the topic.");
    }
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ServiceUnavailableError(UNEXPECTED);
    }
    const parsed = copyResultSchema.safeParse(json);
    if (!parsed.success) throw new ServiceUnavailableError(UNEXPECTED);
    return parsed.data;
  }

  private translateError(err: unknown): Error {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error("[ai] Anthropic rejected the key — check ANTHROPIC_API_KEY in Railway Variables");
      return new ServiceUnavailableError("AI writing isn't set up yet — please contact support.");
    }
    if (err instanceof Anthropic.RateLimitError) return new ServiceUnavailableError("The AI is busy right now — try again in a minute.");
    if (err instanceof Anthropic.APIConnectionError) return new ServiceUnavailableError("Couldn't reach the AI service — please try again.");
    if (err instanceof Anthropic.APIError) {
      console.error(`[ai] Anthropic API error ${err.status}: ${err.message}`);
      return new ServiceUnavailableError("The AI is not available right now — please try again.");
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
