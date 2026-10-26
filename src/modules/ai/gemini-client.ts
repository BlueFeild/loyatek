import { GoogleGenAI } from "@google/genai";

// عميل Google Gemini المشترك (المفتاح GEMINI_API_KEY في Railway Variables بس).
// GEMINI_BASE_URL = سيرفر جوجل بديل للتجارب المحلية بس (زي META_GRAPH_BASE_URL)
export function defaultGeminiClient(): GoogleGenAI {
  const baseUrl = process.env.GEMINI_BASE_URL?.trim();
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
}
