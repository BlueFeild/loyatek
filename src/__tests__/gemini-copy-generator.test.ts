import { describe, expect, it } from "vitest";
import { ApiError, type GoogleGenAI } from "@google/genai";
import { GeminiCopyGenerator } from "../modules/ai/gemini-copy-generator";
import { makeCopyGenerator } from "../modules/ai/ai-providers.factory";
import { AnthropicCopyGenerator } from "../modules/ai/anthropic-copy-generator";
import { FakeCopyGenerator } from "../modules/ai/fake-copy-generator";
import { copyBriefSchema } from "../modules/ai/copy-generator";
import { geminiTextModels } from "../modules/ai/gemini-client";

// عميل Gemini وهمي: بنشوف الطلب ونرد رد ثابت (مفيش نداء حقيقي)
function stubClient(reply: () => Promise<unknown>, seen: any[]) {
  return {
    models: {
      generateContent: async (req: unknown) => {
        seen.push(req);
        return reply();
      },
    },
  } as unknown as GoogleGenAI;
}

const brief = copyBriefSchema.parse({ kind: "whatsapp", topic: "عرض الويكند" });
const biz = { name: "Doha Cafe", industry: "HOSPITALITY" };

describe("GeminiCopyGenerator", () => {
  it("asks for JSON with our schema + system rules and parses it", async () => {
    const seen: any[] = [];
    const gen = new GeminiCopyGenerator(stubClient(async () => ({ text: JSON.stringify({ variants: [{ text: "هلا", hashtags: [] }] }) }), seen), "gemini-flash-latest");
    const out = await gen.generate(brief, biz);
    expect(out.variants[0].text).toBe("هلا");
    expect(seen[0].model).toBe("gemini-flash-latest");
    expect(seen[0].config).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { required: ["variants"] } });
    expect(seen[0].config.systemInstruction).toMatch(/Never invent prices/);
    expect(seen[0].contents).toContain("Doha Cafe");
  });
  it("blocked prompt → 422", async () => {
    const gen = new GeminiCopyGenerator(stubClient(async () => ({ promptFeedback: { blockReason: "SAFETY" }, text: undefined }), []), "m");
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 422 });
  });
  it("free limit (429) → friendly 503", async () => {
    const gen = new GeminiCopyGenerator(
      stubClient(async () => {
        throw new ApiError({ message: "quota", status: 429 });
      }, []),
      "m"
    );
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/limit was reached/) });
  });
  it("garbage → 503", async () => {
    const gen = new GeminiCopyGenerator(stubClient(async () => ({ text: "hello" }), []), "m");
    await expect(gen.generate(brief, biz)).rejects.toMatchObject({ status: 503 });
  });
});

describe("GeminiCopyGenerator with the real SDK over HTTP (local stand-in server)", () => {
  it("sends generateContent with JSON schema and reads the answer", async () => {
    const http = await import("http");
    const { GoogleGenAI } = await import("@google/genai");
    let seen: { url?: string; key?: string; body?: any } = {};
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen = { url: req.url, key: String(req.headers["x-goog-api-key"] ?? ""), body: JSON.parse(raw) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ variants: [{ text: "يا هلا", hashtags: ["#قطر"] }] }) }] }, finishReason: "STOP" }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new GoogleGenAI({ apiKey: "test-key", httpOptions: { baseUrl: `http://127.0.0.1:${port}` } });
      const out = await new GeminiCopyGenerator(client, "gemini-flash-latest").generate(brief, biz);
      expect(out.variants[0]).toEqual({ text: "يا هلا", hashtags: ["#قطر"] });
      expect(seen.url).toContain("gemini-flash-latest:generateContent");
      expect(seen.key).toBe("test-key");
      expect(seen.body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
      expect(JSON.stringify(seen.body)).toContain("Never invent prices");
    } finally {
      server.close();
    }
  });
});

describe("busy model → fallback model (Google 503 high demand)", () => {
  it("first model 503 → second model answers; the request goes to both in order", async () => {
    const seen: string[] = [];
    const client = {
      models: {
        generateContent: async (req: { model: string }) => {
          seen.push(req.model);
          if (req.model === "busy-model") throw new ApiError({ message: "This model is currently experiencing high demand.", status: 503 });
          return { text: JSON.stringify({ variants: [{ text: "هلا", hashtags: [] }] }) };
        },
      },
    } as unknown as GoogleGenAI;
    const out = await new GeminiCopyGenerator(client, ["busy-model", "lite-model"]).generate(brief, biz);
    expect(out.variants[0].text).toBe("هلا");
    expect(seen).toEqual(["busy-model", "lite-model"]);
  });
  it("both busy → friendly message saying nothing was charged", async () => {
    const client = { models: { generateContent: async () => { throw new ApiError({ message: "high demand", status: 503 }); } } } as unknown as GoogleGenAI;
    await expect(new GeminiCopyGenerator(client, ["a", "b"]).generate(brief, biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/very busy.*not charged/) });
  });
  it("a real error (bad key 400) does NOT try the next model", async () => {
    const seen: string[] = [];
    const client = { models: { generateContent: async (req: { model: string }) => { seen.push(req.model); throw new ApiError({ message: "API key not valid", status: 400 }); } } } as unknown as GoogleGenAI;
    await expect(new GeminiCopyGenerator(client, ["a", "b"]).generate(brief, biz)).rejects.toMatchObject({ status: 503 });
    expect(seen).toEqual(["a"]);
  });
  it("models from Railway Variables (fallback default flash-lite, none turns it off)", () => {
    expect(geminiTextModels({})).toEqual(["gemini-flash-latest", "gemini-3.5-flash-lite"]);
    expect(geminiTextModels({ GEMINI_MODEL: "gemini-3.8-flash" })).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    expect(geminiTextModels({ GEMINI_FALLBACK_MODEL: "none" })).toEqual(["gemini-flash-latest"]);
    expect(geminiTextModels({ GEMINI_MODEL: "x", GEMINI_FALLBACK_MODEL: "x" })).toEqual(["x"]);
  });
});

describe("makeCopyGenerator (provider choice from Railway Variables)", () => {
  it("picks Claude first, then Gemini, else none", () => {
    expect(makeCopyGenerator({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toBeInstanceOf(AnthropicCopyGenerator);
    expect(makeCopyGenerator({ GEMINI_API_KEY: "g" })).toBeInstanceOf(GeminiCopyGenerator);
    expect(makeCopyGenerator({})).toBeNull();
  });
  it("AI_PROVIDER forces one (and needs its key)", () => {
    expect(makeCopyGenerator({ AI_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toBeInstanceOf(GeminiCopyGenerator);
    expect(makeCopyGenerator({ AI_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" })).toBeNull();
    expect(makeCopyGenerator({ AI_PROVIDER: "fake" })).toBeInstanceOf(FakeCopyGenerator);
  });
});
