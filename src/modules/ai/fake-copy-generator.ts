import type { BusinessContext, CopyBrief, CopyGenerator, CopyResult } from "./copy-generator";

// مولّد وهمي للتجارب المحلية والاختبارات (AI_PROVIDER=fake) - مابيكلمش أي خدمة
export class FakeCopyGenerator implements CopyGenerator {
  readonly model = "fake";
  calls: { brief: CopyBrief; business: BusinessContext }[] = [];
  failNext: Error | null = null;

  async generate(brief: CopyBrief, business: BusinessContext): Promise<CopyResult> {
    this.calls.push({ brief, business });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const tags = brief.kind === "sms" || brief.kind === "whatsapp" ? [] : ["#قطر", "#الدوحة", `#${business.name.replace(/\s+/g, "")}`];
    return {
      variants: Array.from({ length: brief.variants }, (_, i) => ({
        text: `[${brief.kind}/${brief.dialect}] ${brief.topic} — ${business.name} (${i + 1})`,
        hashtags: tags,
      })),
    };
  }
}
