import { GoogleGenAI } from "@google/genai";

// عميل Google Gemini المشترك (المفتاح GEMINI_API_KEY في Railway Variables بس).
// GEMINI_BASE_URL = سيرفر جوجل بديل للتجارب المحلية بس (زي META_GRAPH_BASE_URL)
export function defaultGeminiClient(): GoogleGenAI {
  const baseUrl = process.env.GEMINI_BASE_URL?.trim();
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
}

export function geminiStatus(err: unknown): number {
  return Number((err as { status?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode);
}

// موديلات الكتابة والتحليل بالترتيب: الأساسي، وبعده بديل لو الأساسي "مزحوم"
// (جوجل بترد 503 high demand كتير في الباقة المجانية) - الاتنين من Railway Variables
export function geminiTextModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = env.GEMINI_MODEL?.trim() || "gemini-flash-latest";
  const fallback = env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.5-flash-lite";
  return [...new Set([primary, fallback].filter((m) => m && m !== "none"))];
}

const BUSY = new Set([429, 500, 502, 503, 504]);

// يجرب الموديلات بالترتيب: لو جوجل قالت "زحمة/حد" نروح للي بعده، أي خطأ تاني يطلع على طول
export async function withModelFallback<T>(models: string[], call: (model: string) => Promise<T>): Promise<T> {
  let lastErr: unknown = new Error("No Gemini model configured");
  for (const model of models) {
    try {
      return await call(model);
    } catch (err) {
      lastErr = err;
      const status = geminiStatus(err);
      if (!BUSY.has(status)) throw err;
      console.warn(`[ai] Gemini ${model} is busy (${status}) — trying the next model`);
    }
  }
  throw lastErr;
}
