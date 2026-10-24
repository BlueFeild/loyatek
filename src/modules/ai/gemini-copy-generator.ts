import { ApiError, GoogleGenAI } from "@google/genai";
import { AppError, ServiceUnavailableError } from "../../core/errors";
import { copyResultSchema, type BusinessContext, type CopyBrief, type CopyGenerator, type CopyResult } from "./copy-generator";
import { buildCopyPrompt, COPYWRITER_SYSTEM } from "./copywriter.prompts";
import { COPY_OUTPUT_SCHEMA } from "./copy-output-schema";

const UNEXPECTED = "The AI returned an unexpected answer — please try again.";

// بديل مجاني/أرخص: Google Gemini (المفتاح GEMINI_API_KEY في Railway Variables بس).
// ملحوظة: في باقة Gemini المجانية جوجل ممكن تستخدم البيانات لتحسين خدماتها - للتجربة بس
export class GeminiCopyGenerator implements CopyGenerator {
  readonly model: string;

  constructor(
    private readonly client: GoogleGenAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
    model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest"
  ) {
    this.model = model;
  }

  async generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult> {
    let text: string | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: buildCopyPrompt(brief, business),
        config: { systemInstruction: COPYWRITER_SYSTEM, responseMimeType: "application/json", responseJsonSchema: COPY_OUTPUT_SCHEMA },
      });
      if (response.promptFeedback?.blockReason) {
        throw new AppError(422, "AI_REFUSED", "The AI couldn't write this one — please rephrase the topic.");
      }
      text = response.text;
    } catch (err) {
      throw this.translateError(err);
    }

    let json: unknown;
    try {
      json = JSON.parse(text ?? "");
    } catch {
      throw new ServiceUnavailableError(UNEXPECTED);
    }
    const parsed = copyResultSchema.safeParse(json);
    if (!parsed.success) throw new ServiceUnavailableError(UNEXPECTED);
    return parsed.data;
  }

  private translateError(err: unknown): Error {
    if (err instanceof AppError) return err;
    if (err instanceof ApiError) {
      if (err.status === 429) return new ServiceUnavailableError("The free AI limit was reached — try again in a minute.");
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        console.error(`[ai] Gemini rejected the request (${err.status}) — check GEMINI_API_KEY / GEMINI_MODEL in Railway Variables`);
        return new ServiceUnavailableError("AI writing isn't set up yet — please contact support.");
      }
      console.error(`[ai] Gemini API error ${err.status}: ${err.message}`);
      return new ServiceUnavailableError("The AI is not available right now — please try again.");
    }
    console.error("[ai] Gemini call failed:", err);
    return new ServiceUnavailableError("Couldn't reach the AI service — please try again.");
  }
}
