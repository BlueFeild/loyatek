import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../../core/errors";
import { copyResultSchema, type BusinessContext, type CopyBrief, type CopyGenerator, type CopyResult } from "./copy-generator";
import { buildCopyPrompt, COPYWRITER_SYSTEM } from "./copywriter.prompts";
import { COPY_OUTPUT_SCHEMA } from "./copy-output-schema";
import { anthropicModel, responseText, translateAnthropicError } from "./anthropic-shared";
import { parseStructured } from "./structured-output";

// تطبيق CopyGenerator باستخدام Claude. المفتاح ANTHROPIC_API_KEY في Railway Variables بس
export class AnthropicCopyGenerator implements CopyGenerator {
  constructor(
    private readonly client: Anthropic = new Anthropic({ timeout: 90_000, maxRetries: 2 }),
    readonly model: string = anthropicModel()
  ) {}

  async generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // لو المودل رفض لسبب أمان، Anthropic بتعيد الطلب على البديل المناسب تلقائي
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: COPY_OUTPUT_SCHEMA } },
        system: COPYWRITER_SYSTEM,
        messages: [{ role: "user", content: buildCopyPrompt(brief, business) }],
      });
    } catch (err) {
      throw translateAnthropicError(err, "writing");
    }

    if (response.stop_reason === "refusal") {
      throw new AppError(422, "AI_REFUSED", "The AI couldn't write this one — please rephrase the topic.");
    }
    return parseStructured(copyResultSchema, responseText(response));
  }
}
