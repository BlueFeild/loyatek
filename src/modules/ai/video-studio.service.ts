import { AppError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { AssetStore } from "./ai-asset.repository";
import type { GenerationRow, GenerationStore } from "./ai-generation.repository";
import { AI_COSTS } from "./ai-pricing";
import type { InputImage, VideoBrief, VideoGenerator } from "./media-types";

const MAX_RUNNING_PER_COMPANY = 2;

// صانع الفيديو: الفيديو بياخد دقايق، فبنشتغل في الخلفية:
// نحجز النقاط ← نسجل العملية PENDING ← نرجع على طول ← لما يخلص نحفظه (أو نرجّع النقاط لو فشل).
// الشاشة بتسأل عن الحالة كل شوية
export class VideoStudioService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly generator: VideoGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly assets: AssetStore,
    private readonly staleAfterMs = 20 * 60_000
  ) {}

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async start(tenantId: string, userId: string | null, brief: VideoBrief) {
    const generator = this.generator;
    if (!generator) throw new ServiceUnavailableError("AI videos aren't set up yet — please contact support.");
    const business = await this.generations.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const recent = await this.history(tenantId);
    if (recent.filter((g) => g.status === "PENDING").length >= MAX_RUNNING_PER_COMPANY) {
      throw new AppError(429, "TOO_MANY_VIDEOS", "Please wait — you already have videos being made.");
    }
    const image = await this.resolveSourceImage(tenantId, brief);

    const cost = AI_COSTS.video;
    const { sourceImage, ...rest } = brief;
    const job = await this.generations.create({
      tenantId,
      userId,
      tool: "video",
      kind: image ? "image_to_video" : "text_to_video",
      input: { ...rest, withUploadedPhoto: Boolean(sourceImage) },
      output: {},
      creditsUsed: cost,
      model: generator.model,
      status: "PENDING",
    });
    let balance: number;
    try {
      balance = await this.credits.spend({ tenantId, cost, reason: "AI_VIDEO", userId, refId: job.id });
    } catch (err) {
      await this.generations.finish(job.id, { status: "FAILED", error: "Not enough credits", creditsUsed: 0 });
      throw err;
    }

    const work = this.run(job.id, tenantId, userId, cost, { prompt: brief.prompt, aspectRatio: brief.aspectRatio, image }, business).finally(() =>
      this.running.delete(job.id)
    );
    this.running.set(job.id, work);
    return { id: job.id, status: "PENDING" as const, creditsUsed: cost, balance };
  }

  private async run(
    jobId: string,
    tenantId: string,
    userId: string | null,
    cost: number,
    brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage },
    business: { name: string; industry: string }
  ) {
    try {
      const media = await this.generator!.generate(brief, business);
      await this.assets.save({ tenantId, generationId: jobId, kind: "video", mimeType: media.mimeType, base64: media.base64 });
      await this.generations.finish(jobId, { status: "DONE", output: { mimeType: media.mimeType } });
    } catch (err) {
      const message = err instanceof AppError ? err.message : "The video couldn't be made — please try again.";
      if (!(err instanceof AppError)) console.error(`[ai] video job ${jobId} failed:`, err);
      await this.generations.finish(jobId, { status: "FAILED", error: message, creditsUsed: 0 }).catch(() => {});
      await this.credits.refund({ tenantId, cost, reason: "AI_VIDEO", userId, refId: jobId }).catch((e) => console.error(`[ai] refund for ${jobId} failed:`, e));
    }
  }

  // صورة من الجهاز، أو صورة عملها استوديو الصور لنفس الشركة
  private async resolveSourceImage(tenantId: string, brief: VideoBrief): Promise<InputImage | undefined> {
    if (brief.sourceImage) return brief.sourceImage;
    if (!brief.sourceAssetId) return undefined;
    const asset = await this.assets.get(tenantId, brief.sourceAssetId);
    if (!asset || asset.kind !== "image") throw new ValidationError("Choose one of your AI images to animate");
    const mime = asset.mimeType === "image/jpeg" || asset.mimeType === "image/webp" ? asset.mimeType : "image/png";
    return { base64: asset.data.toString("base64"), mimeType: mime };
  }

  async get(tenantId: string, id: string): Promise<GenerationRow> {
    await this.expireStale(tenantId);
    const job = await this.generations.find(tenantId, id);
    if (!job || job.tool !== "video") throw new NotFoundError("Video not found");
    return job;
  }

  async history(tenantId: string) {
    await this.expireStale(tenantId);
    return this.generations.recent(tenantId, "video");
  }

  // فيديو فضل PENDING كتير (السيرفر اتعاد تشغيله وهو شغال) ← FAILED ونرجّع النقاط
  private async expireStale(tenantId: string) {
    const cutoff = new Date(Date.now() - this.staleAfterMs);
    const stale = (await this.generations.recent(tenantId, "video")).filter((g) => g.status === "PENDING" && g.createdAt < cutoff && !this.running.has(g.id));
    for (const g of stale) {
      await this.generations.finish(g.id, { status: "FAILED", error: "The video took too long — your credits were returned. Please try again.", creditsUsed: 0 });
      await this.credits.refund({ tenantId, cost: g.creditsUsed, reason: "AI_VIDEO", refId: g.id }).catch(() => {});
    }
  }

  // للاختبارات: نستنى كل الفيديوهات اللي شغالة تخلص
  async whenIdle() {
    await Promise.all([...this.running.values()]);
  }
}
