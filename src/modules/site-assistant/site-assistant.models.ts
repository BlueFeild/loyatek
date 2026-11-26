import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { ServiceUnavailableError } from "../../core/errors";
import { anthropicModel, responseText, translateAnthropicError } from "../ai/anthropic-shared";
import { defaultGeminiClient, geminiTextModels, withModelFallback } from "../ai/gemini-client";
import { translateGeminiError } from "../ai/gemini-errors";
import { parseStructured, UNEXPECTED_AI_ANSWER } from "../ai/structured-output";
import { cleanAnswer, SITE_ANSWER_JSON_SCHEMA, SITE_ASSISTANT_LIMITS, siteAnswerSchema, type SiteAnswer, type SiteAssistantInput, type SiteAssistantModel } from "./site-assistant.types";

function finish(text: string | undefined): SiteAnswer {
  const clean = cleanAnswer(parseStructured(siteAnswerSchema, text));
  if (!clean) throw new ServiceUnavailableError(UNEXPECTED_AI_ANSWER);
  return clean;
}

// Gemini: مهلة قصيرة ومن غير إعادة محاولة جوه المكتبة (زي الكاتب) - الزائر مستني
export class GeminiSiteAssistant implements SiteAssistantModel {
  readonly model: string;
  private readonly models: string[];

  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    models: string | string[] = geminiTextModels()
  ) {
    this.models = Array.isArray(models) ? models : [models];
    this.model = this.models[0];
  }

  async reply(input: SiteAssistantInput): Promise<SiteAnswer> {
    let text: string | undefined;
    try {
      const response = await withModelFallback(this.models, (model) =>
        this.client.models.generateContent({
          model,
          contents: input.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          config: {
            systemInstruction: input.system,
            responseMimeType: "application/json",
            responseJsonSchema: SITE_ANSWER_JSON_SCHEMA,
            httpOptions: { timeout: SITE_ASSISTANT_LIMITS.timeoutMs, retryOptions: { attempts: 1 } },
          },
        })
      );
      text = response.text;
    } catch (err) {
      throw translateGeminiError(err, "writing");
    }
    return finish(text);
  }
}

// Claude: مجهود قليل عشان الرد يبقى سريع
export class AnthropicSiteAssistant implements SiteAssistantModel {
  constructor(
    private readonly client: Anthropic = new Anthropic({ timeout: SITE_ASSISTANT_LIMITS.timeoutMs, maxRetries: 0 }),
    readonly model: string = anthropicModel()
  ) {}

  async reply(input: SiteAssistantInput): Promise<SiteAnswer> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 1500,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SITE_ANSWER_JSON_SCHEMA } },
        system: input.system,
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (err) {
      throw translateAnthropicError(err, "writing");
    }
    if (response.stop_reason === "refusal") throw new ServiceUnavailableError(UNEXPECTED_AI_ANSWER);
    return finish(responseText(response));
  }
}

// للتجارب (AI_PROVIDER=fake): رد ثابت فيه أيام التجربة وسعر الحجز من الـ prompt (عشان نتأكد إنهم لايف)
export class FakeSiteAssistant implements SiteAssistantModel {
  readonly model = "fake";
  calls: SiteAssistantInput[] = [];
  failNext: Error | null = null;

  async reply(input: SiteAssistantInput): Promise<SiteAnswer> {
    this.calls.push(input);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const trial = /free trial of (\d+) day/.exec(input.system)?.[1] ?? "0";
    const booking = /- Booking system: ([A-Z]{3} [\d,.]+) per month/.exec(input.system)?.[1] ?? "?";
    const last = input.messages[input.messages.length - 1]?.content ?? "";
    const ar = /[؀-ۿ]/.test(last) || /reply in simple, friendly Arabic unless/.test(input.system);
    return {
      reply: ar ? `[fake] التجربة ${trial} يوم. الحجوزات ${booking} شهريًا.` : `[fake] Trial ${trial} days. Booking ${booking} a month. You asked: ${last.slice(0, 60)}`,
      suggestions: ar ? ["كام السعر؟"] : ["How much does it cost?"],
      links: [{ path: "/pricing", label: ar ? "الأسعار" : "Pricing" }],
    };
  }
}

// نفس اختيار المزوّد بتاع الكاتب: AI_PROVIDER = anthropic | gemini | fake، وإلا Claude لو مفتاحه موجود، وإلا Gemini
export function makeSiteAssistantModel(env: NodeJS.ProcessEnv = process.env): SiteAssistantModel | null {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "fake") return new FakeSiteAssistant();
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const hasGemini = Boolean(env.GEMINI_API_KEY?.trim());
  const pick = provider === "anthropic" ? (hasClaude ? "anthropic" : null) : provider === "gemini" ? (hasGemini ? "gemini" : null) : hasClaude ? "anthropic" : hasGemini ? "gemini" : null;
  if (pick === "anthropic") return new AnthropicSiteAssistant();
  if (pick === "gemini") return new GeminiSiteAssistant();
  return null;
}
