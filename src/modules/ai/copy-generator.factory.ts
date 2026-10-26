import { AnthropicCopyGenerator } from "./anthropic-copy-generator";
import { AnthropicAccountAuditor } from "./anthropic-account-auditor";
import type { CopyGenerator } from "./copy-generator";
import { FakeCopyGenerator } from "./fake-copy-generator";
import { FakeAccountAuditor, FakeImageGenerator, FakeVideoGenerator } from "./fake-media-providers";
import { GeminiCopyGenerator } from "./gemini-copy-generator";
import { GeminiAccountAuditor, GeminiImageGenerator, GeminiVideoGenerator } from "./gemini-media-providers";
import type { AccountAuditor, ImageGenerator, VideoGenerator } from "./media-types";

export interface AiProviders {
  copy: CopyGenerator | null;
  image: ImageGenerator | null;
  video: VideoGenerator | null;
  auditor: AccountAuditor | null;
}

// اختيار المزوّدين من Railway Variables:
// AI_PROVIDER = anthropic | gemini | fake (fake للتجارب المحلية بس) - للكتابة والتحليل.
// من غيره: Claude لو ANTHROPIC_API_KEY موجود، وإلا Gemini لو GEMINI_API_KEY موجود.
// الصور والفيديو: Gemini بس (Claude مابيعملش صور/فيديو)
export function makeAiProviders(env: NodeJS.ProcessEnv = process.env): AiProviders {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "fake") {
    return { copy: new FakeCopyGenerator(), image: new FakeImageGenerator(), video: new FakeVideoGenerator(), auditor: new FakeAccountAuditor() };
  }
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY?.trim());
  const hasGemini = Boolean(env.GEMINI_API_KEY?.trim());
  const textProvider = provider === "anthropic" ? (hasClaude ? "anthropic" : null) : provider === "gemini" ? (hasGemini ? "gemini" : null) : hasClaude ? "anthropic" : hasGemini ? "gemini" : null;

  return {
    copy: textProvider === "anthropic" ? new AnthropicCopyGenerator() : textProvider === "gemini" ? new GeminiCopyGenerator() : null,
    auditor: textProvider === "anthropic" ? new AnthropicAccountAuditor() : textProvider === "gemini" ? new GeminiAccountAuditor() : null,
    image: hasGemini ? new GeminiImageGenerator() : null,
    video: hasGemini ? new GeminiVideoGenerator() : null,
  };
}

export function makeCopyGenerator(env: NodeJS.ProcessEnv = process.env): CopyGenerator | null {
  return makeAiProviders(env).copy;
}
