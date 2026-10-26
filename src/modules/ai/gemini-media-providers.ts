import { GoogleGenAI } from "@google/genai";
import { AppError } from "../../core/errors";
import type { BusinessContext } from "./copy-generator";
import { defaultGeminiClient } from "./gemini-client";
import { translateGeminiError } from "./gemini-errors";
import {
  AUDIT_OUTPUT_SCHEMA,
  parseAuditReport,
  type AccountAuditor,
  type AuditInput,
  type AuditMetrics,
  type AuditReport,
  type GeneratedMedia,
  type ImageBrief,
  type ImageGenerator,
  type InputImage,
  type VideoBrief,
  type VideoGenerator,
} from "./media-types";
import { AUDIT_SYSTEM, buildAuditPrompt, buildImagePrompt, buildVideoPrompt } from "./media.prompts";

// مزوّدات Google Gemini (Interactions API) - المفتاح GEMINI_API_KEY في Railway Variables بس.
// أسماء الموديلات قابلة للتغيير من Railway لو جوجل غيّرتها (حصل مع Veo في أكتوبر 2026)

type Part = { type: "text"; text: string } | { type: "image"; data: string; mime_type: string };

const imagePart = (img: InputImage): Part => ({ type: "image", data: img.base64, mime_type: img.mimeType });


export class GeminiImageGenerator implements ImageGenerator {
  readonly model: string;
  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    model = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-nano-banana-2.1"
  ) {
    this.model = model;
  }

  async generate(brief: ImageBrief, business: BusinessContext): Promise<GeneratedMedia> {
    const text = buildImagePrompt(brief, business);
    const input: Part[] = brief.productImage ? [{ type: "text", text }, imagePart(brief.productImage)] : [{ type: "text", text }];
    let out: { data?: string; mime_type?: string } | undefined;
    try {
      const interaction = await this.client.interactions.create({
        model: this.model,
        input,
        response_format: { type: "image", aspect_ratio: brief.aspectRatio, image_size: "1K" },
        store: false,
      });
      out = interaction.output_image;
    } catch (err) {
      throw translateGeminiError(err, "image");
    }
    if (!out?.data) throw new AppError(422, "AI_REFUSED", "The AI didn't return an image — please change the description and try again.");
    return { base64: out.data, mimeType: out.mime_type || "image/png" };
  }
}

export class GeminiVideoGenerator implements VideoGenerator {
  readonly model: string;
  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    model = process.env.GEMINI_VIDEO_MODEL?.trim() || "gemini-omni-1.1-flash"
  ) {
    this.model = model;
  }

  async generate(brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage }, business: BusinessContext): Promise<GeneratedMedia> {
    const text = buildVideoPrompt(brief.prompt, business, Boolean(brief.image));
    const input: Part[] = brief.image ? [imagePart(brief.image), { type: "text", text }] : [{ type: "text", text }];
    let out: { data?: string; mime_type?: string } | undefined;
    try {
      const interaction = await this.client.interactions.create({
        model: this.model,
        input,
        response_format: { type: "video", aspect_ratio: brief.aspectRatio, resolution: "720p" },
        store: false,
      });
      out = interaction.output_video;
    } catch (err) {
      throw translateGeminiError(err, "video");
    }
    if (!out?.data) throw new AppError(422, "AI_REFUSED", "The AI didn't return a video — please change the description and try again.");
    return { base64: out.data, mimeType: out.mime_type || "video/mp4" };
  }
}

export class GeminiAccountAuditor implements AccountAuditor {
  readonly model: string;
  constructor(
    private readonly client: GoogleGenAI = defaultGeminiClient(),
    model = process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest"
  ) {
    this.model = model;
  }

  async audit(input: AuditInput, metrics: AuditMetrics, business: BusinessContext): Promise<AuditReport> {
    const parts: Part[] = [{ type: "text", text: buildAuditPrompt(input, metrics, business) }, ...input.screenshots.map(imagePart)];
    let text: string | undefined;
    try {
      const interaction = await this.client.interactions.create({
        model: this.model,
        input: parts,
        system_instruction: AUDIT_SYSTEM,
        response_format: { type: "text", mime_type: "application/json", schema: AUDIT_OUTPUT_SCHEMA },
        store: false,
      });
      text = interaction.output_text;
    } catch (err) {
      throw translateGeminiError(err, "audit");
    }
    return parseAuditReport(text);
  }
}
