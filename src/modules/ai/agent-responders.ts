import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { AppError, ServiceUnavailableError } from "../../core/errors";
import { AGENT_OUTPUT_SCHEMA, agentReplySchema, cleanAgentReply, type AgentInput, type AgentReply, type AgentResponder } from "./agent-types";
import { AGENT_SYSTEM, buildAgentPrompt } from "./agent.prompts";
import { anthropicModel, responseText, translateAnthropicError } from "./anthropic-shared";
import { defaultGeminiClient, GEMINI_TEXT_HTTP, geminiTextModels, withModelFallback } from "./gemini-client";
import { translateGeminiError } from "./gemini-errors";
import { parseStructured, UNEXPECTED_AI_ANSWER } from "./structured-output";

function finish(raw: AgentReply): AgentReply {
  const clean = cleanAgentReply(raw);
  if (!clean) throw new ServiceUnavailableError(UNEXPECTED_AI_ANSWER);
  return clean;
}

// Google Gemini (GEMINI_API_KEY) - نفس إعدادات الكاتب: مهلة 40 ثانية ومن غير إعادة محاولة جوه المكتبة
export class GeminiAgentResponder implements AgentResponder {
  readonly model: string;
  private readonly models: string[];

  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    models: string | string[] = geminiTextModels()
  ) {
    this.models = Array.isArray(models) ? models : [models];
    this.model = this.models[0];
  }

  async reply(input: AgentInput): Promise<AgentReply> {
    let text: string | undefined;
    try {
      const response = await withModelFallback(this.models, (model) =>
        this.client.models.generateContent({
          model,
          contents: buildAgentPrompt(input),
          config: { systemInstruction: AGENT_SYSTEM, responseMimeType: "application/json", responseJsonSchema: AGENT_OUTPUT_SCHEMA, httpOptions: GEMINI_TEXT_HTTP },
        })
      );
      if (response.promptFeedback?.blockReason) throw new AppError(422, "AI_REFUSED", "The AI couldn't answer this message.");
      text = response.text;
    } catch (err) {
      throw translateGeminiError(err, "writing");
    }
    return finish(parseStructured(agentReplySchema, text));
  }
}

// Claude (ANTHROPIC_API_KEY) - مجهود قليل عشان الرد يبقى سريع
export class AnthropicAgentResponder implements AgentResponder {
  constructor(
    private readonly client: Anthropic = new Anthropic({ timeout: 45_000, maxRetries: 1 }),
    readonly model: string = anthropicModel()
  ) {}

  async reply(input: AgentInput): Promise<AgentReply> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 2000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: AGENT_OUTPUT_SCHEMA } },
        system: AGENT_SYSTEM,
        messages: [{ role: "user", content: buildAgentPrompt(input) }],
      });
    } catch (err) {
      throw translateAnthropicError(err, "writing");
    }
    if (response.stop_reason === "refusal") throw new AppError(422, "AI_REFUSED", "The AI couldn't answer this message.");
    return finish(parseStructured(agentReplySchema, responseText(response)));
  }
}

const HUMAN_WORDS = /human|agent|staff|manager|complain|refund|موظف|مدير|شكوى|شكوي|استرجاع|انسان|إنسان/i;

// للتجارب المحلية والاختبارات (AI_PROVIDER=fake) - رد ثابت من البيانات، وبيحوّل لموظف لو العميل طلب
export class FakeAgentResponder implements AgentResponder {
  readonly model = "fake";
  calls: AgentInput[] = [];
  failNext: Error | null = null;

  async reply(input: AgentInput): Promise<AgentReply> {
    this.calls.push(input);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (HUMAN_WORDS.test(input.message)) return { reply: "Sure — a team member will reply to you shortly 🙏", handoff: true, reason: "Customer asked for a person" };
    const first = input.business.menu[0] ?? null;
    const link = input.business.links.menu ?? input.business.links.booking;
    return {
      reply: `[${input.business.dialect}] ${input.business.name}: ${first ? `${first.name} is ${first.price}.` : "Hello!"}${link ? ` ${link}` : ""}`,
      handoff: false,
      reason: "",
    };
  }
}
