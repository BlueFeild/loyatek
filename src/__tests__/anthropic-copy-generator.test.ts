import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicCopyGenerator } from "../modules/ai/anthropic-copy-generator";
import { copyBriefSchema } from "../modules/ai/copy-generator";

// شبكة وهمية: بنشوف الطلب اللي رايح لـ Claude ونرد رد ثابت (مفيش نداء حقيقي ولا تكلفة)
function clientReturning(status: number, body: unknown, seen: { url?: string; body?: any; headers?: Headers }[]) {
  return new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  });
}

const message = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const brief = copyBriefSchema.parse({ kind: "caption", topic: "قهوة جديدة", variants: 2 });
const biz = { name: "Doha Cafe", industry: "RESTAURANT" };

describe("AnthropicCopyGenerator", () => {
  it("sends Opus 5.5 with structured output + default fallbacks and parses the variants", async () => {
    const seen: any[] = [];
    const gen = new AnthropicCopyGenerator(clientReturning(200, message(JSON.stringify({ variants: [{ text: "يا هلا", hashtags: ["#قطر"] }] })), seen));
    const out = await gen.generate(brief, biz);
    expect(out.variants[0]).toEqual({ text: "يا هلا", hashtags: ["#قطر"] });
    const req = seen[0];
    expect(req.url).toContain("/v1/messages");
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "medium", format: { type: "json_schema" } } });
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body.messages[0].content).toContain("Doha Cafe");
  });
  it("refusal → clear 422", async () => {
    const gen = new AnthropicCopyGenerator(clientReturning(200, message("", "refusal"), []));
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 422, code: "AI_REFUSED" });
  });
  it("bad key → 503 'not set up' (no key details leaked)", async () => {
    const gen = new AnthropicCopyGenerator(clientReturning(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, []));
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/isn't set up/) });
  });
  it("garbage answer → 503 try again", async () => {
    const gen = new AnthropicCopyGenerator(clientReturning(200, message("not json"), []));
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 503 });
  });
});
