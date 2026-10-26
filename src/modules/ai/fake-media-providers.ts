import type { BusinessContext } from "./copy-generator";
import type { AccountAuditor, AuditInput, AuditMetrics, AuditReport, GeneratedMedia, ImageBrief, ImageGenerator, InputImage, VideoBrief, VideoGenerator } from "./media-types";

// مزوّدات وهمية للتجارب المحلية والاختبارات (AI_PROVIDER=fake) - مابتكلمش أي خدمة

// صورة PNG حقيقية 1×1 (عشان المتصفح يقدر يعرضها)
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class FailOnce {
  failNext: Error | null = null;
  protected maybeFail() {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }
}

export class FakeImageGenerator extends FailOnce implements ImageGenerator {
  readonly model = "fake-image";
  calls: { brief: ImageBrief; business: BusinessContext }[] = [];
  async generate(brief: ImageBrief, business: BusinessContext): Promise<GeneratedMedia> {
    this.calls.push({ brief, business });
    this.maybeFail();
    return { base64: PNG_1PX, mimeType: "image/png" };
  }
}

export class FakeVideoGenerator extends FailOnce implements VideoGenerator {
  readonly model = "fake-video";
  delayMs = 50;
  calls: { brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage }; business: BusinessContext }[] = [];
  async generate(brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage }, business: BusinessContext): Promise<GeneratedMedia> {
    this.calls.push({ brief, business });
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.maybeFail();
    return { base64: Buffer.from(`fake-mp4:${brief.prompt}`).toString("base64"), mimeType: "video/mp4" };
  }
}

export class FakeAccountAuditor extends FailOnce implements AccountAuditor {
  readonly model = "fake-audit";
  calls: { input: AuditInput; metrics: AuditMetrics }[] = [];
  async audit(input: AuditInput, metrics: AuditMetrics, business: BusinessContext): Promise<AuditReport> {
    this.calls.push({ input, metrics });
    this.maybeFail();
    return {
      healthScore: 62,
      summary: `${business.name} on ${input.platform} (${input.handle}) — engagement ${metrics.engagementRate ?? "unknown"}%.`,
      engagementVerdict: "Average for the niche.",
      strengths: ["Clear branding"],
      weaknesses: ["Irregular posting"],
      opportunities: ["Reels"],
      threats: ["Competitors running ads"],
      quickWins: ["Pin your best post"],
      contentPlan: [{ pillar: "Behind the scenes", idea: "Show a day at the studio" }],
      postingSchedule: "4 posts a week, 7-10 pm Doha time",
      adPlan: { objective: "WhatsApp messages", audience: "Doha, 25-45", dailyBudgetQar: 50, durationDays: 7, creativeIdea: "Before/after reel" },
    };
  }
}
