import { GoogleGenAI } from "@google/genai";
import { AppError } from "../../core/errors";
import { copyResultSchema, type BusinessContext, type CopyBrief, type CopyGenerator, type CopyResult } from "./copy-generator";
import { buildCopyPrompt, COPYWRITER_SYSTEM } from "./copywriter.prompts";
import { COPY_OUTPUT_SCHEMA } from "./copy-output-schema";
import { defaultGeminiClient, GEMINI_TEXT_HTTP, geminiTextModels, withModelFallback } from "./gemini-client";
import { translateGeminiError } from "./gemini-errors";
import { parseStructured } from "./structured-output";

// بديل مجاني/أرخص: Google Gemini (المفتاح GEMINI_API_KEY في Railway Variables بس).
// ملحوظة: في باقة Gemini المجانية جوجل ممكن تستخدم البيانات لتحسين خدماتها - للتجربة بس
export class GeminiCopyGenerator implements CopyGenerator {
  readonly model: string;
  private readonly models: string[];

  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    models: string | string[] = geminiTextModels()
  ) {
    this.models = Array.isArray(models) ? models : [models];
    this.model = this.models[0];
  }

  async generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult> {
    let text: string | undefined;
    try {
      const response = await withModelFallback(this.models, (model) =>
        this.client.models.generateContent({
          model,
          contents: buildCopyPrompt(brief, business),
          config: { systemInstruction: COPYWRITER_SYSTEM, responseMimeType: "application/json", responseJsonSchema: COPY_OUTPUT_SCHEMA, httpOptions: GEMINI_TEXT_HTTP },
        })
      );
      if (response.promptFeedback?.blockReason) {
        throw new AppError(422, "AI_REFUSED", "The AI couldn't write this one — please rephrase the topic.");
      }
      text = response.text;
    } catch (err) {
      throw translateGeminiError(err, "writing");
    }

    return parseStructured(copyResultSchema, text);
  }
}
