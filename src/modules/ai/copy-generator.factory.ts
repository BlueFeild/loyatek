import { AnthropicCopyGenerator } from "./anthropic-copy-generator";
import type { CopyGenerator } from "./copy-generator";
import { FakeCopyGenerator } from "./fake-copy-generator";
import { GeminiCopyGenerator } from "./gemini-copy-generator";

// اختيار المزوّد من Railway Variables:
// AI_PROVIDER = anthropic | gemini | fake (fake للتجارب المحلية بس).
// من غيره: Claude لو ANTHROPIC_API_KEY موجود، وإلا Gemini لو GEMINI_API_KEY موجود
export function makeCopyGenerator(env: NodeJS.ProcessEnv = process.env): CopyGenerator | null {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const hasGemini = Boolean(env.GEMINI_API_KEY?.trim());
  if (provider === "fake") return new FakeCopyGenerator();
  if (provider === "anthropic") return hasClaude ? new AnthropicCopyGenerator() : null;
  if (provider === "gemini") return hasGemini ? new GeminiCopyGenerator() : null;
  if (hasClaude) return new AnthropicCopyGenerator();
  if (hasGemini) return new GeminiCopyGenerator();
  return null;
}
