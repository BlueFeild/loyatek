import { randomUUID } from "crypto";
import { AppError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../core/errors";
import type { CreditService, SpendRequest } from "../credits/credit.service";
import type { AssetStore } from "./ai-asset.repository";
import type { GenerationRow, GenerationStore } from "./ai-generation.repository";
import type { BusinessProfileReader } from "./business-profile.repository";
import { AI_COSTS, AI_LIMITS, type VideoLimits } from "./ai-pricing";
import type { InputImage, VideoBrief, VideoGenerator } from "./media-types";
import type { BusinessContext } from "./copy-generator";

const TIMED_OUT = "The video took too long — your credits were returned. Please try again.";

// مهلة لأي وعد: لو المزوّد علّق، بنفشل العملية بدل ما تفضل PENDING على طول
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError(504, "AI_TIMEOUT", TIMED_OUT)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// صانع الفيديو: الفيديو بياخد دقايق، فبنشتغل في الخلفية:
// نحجز النقاط ← نسجل العملية PENDING ← نرجع على طول ← لما يخلص نحفظه (أو نرجّع النقاط لو فشل).
// إنهاء العملية "قفل" ذرّي: اللي يقفلها هو بس اللي يرجّع النقاط (مفيش ترجيع مرتين)
export class VideoStudioService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly limits: VideoLimits;

  constructor(
    private readonly generator: VideoGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly assets: AssetStore,
    private readonly profiles: BusinessProfileReader,
    limits: Partial<VideoLimits> = {}
  ) {
    this.limits = { timeoutMs: AI_LIMITS.videoTimeoutMs, staleAfterMs: AI_LIMITS.videoStaleAfterMs, maxRunning: AI_LIMITS.maxRunningVideosPerCompany, ...limits };
  }

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async start(tenantId: string, userId: string | null, brief: VideoBrief) {
    const generator = this.generator;
    if (!generator) throw new ServiceUnavailableError("AI videos aren't set up yet — please contact support.");
    const business = await this.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    await this.expireStale(tenantId);
    if ((await this.generations.countPending(tenantId, "video")) >= this.limits.maxRunning) {
      throw new AppError(429, "TOO_MANY_VIDEOS", "Please wait — you already have videos being made.");
    }
    const image = await this.resolveSourceImage(tenantId, brief);

    const cost = AI_COSTS.video;
    const id = randomUUID();
    const charge: SpendRequest = { tenantId, cost, reason: "AI_VIDEO", userId, refId: id };
    // الحجز الأول: من غير رصيد مفيش عملية خالص
    const balance = await this.credits.spend(charge);
    const { sourceImage, ...rest } = brief;
    try {
      await this.generations.create({
        id,
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
    } catch (err) {
      await this.credits.refund(charge).catch((e) => console.error(`[ai] refund for ${id} failed:`, e));
      throw err;
    }

    const work = this.run(id, charge, generator, { prompt: brief.prompt, aspectRatio: brief.aspectRatio, image }, business).finally(() => this.running.delete(id));
    this.running.set(id, work);
    return { id, status: "PENDING" as const, creditsUsed: cost, balance };
  }

  private async run(
    jobId: string,
    charge: SpendRequest,
    generator: VideoGenerator,
    brief: { prompt: string; aspectRatio: VideoBrief["aspectRatio"]; image?: InputImage },
    business: BusinessContext
  ) {
    try {
      const media = await withTimeout(generator.generate(brief, business), this.limits.timeoutMs);
      await this.assets.save({ tenantId: charge.tenantId, generationId: jobId, kind: "video", mimeType: media.mimeType, base64: media.base64 });
      const won = await this.generations.finishPending(jobId, { status: "DONE", output: { mimeType: media.mimeType } });
      if (!won) console.warn(`[ai] video job ${jobId} finished after it had already been closed`);
    } catch (err) {
      const message = err instanceof AppError ? err.message : "The video couldn't be made — please try again.";
      if (!(err instanceof AppError)) console.error(`[ai] video job ${jobId} failed:`, err);
      // لو القفل فشل (مشكلة قاعدة بيانات) مانرجّعش هنا - expireStale هيقفلها ويرجّع بعدين
      const won = await this.generations.finishPending(jobId, { status: "FAILED", error: message, creditsUsed: 0 }).catch(() => false);
      if (won) await this.credits.refund(charge).catch((e) => console.error(`[ai] refund for ${jobId} failed:`, e));
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

  // فيديو فضل PENDING كتير ومش شغال هنا (السيرفر اتعاد تشغيله وهو شغال) ← FAILED ونرجّع النقاط مرة واحدة بس
  private async expireStale(tenantId: string) {
    const cutoff = new Date(Date.now() - this.limits.staleAfterMs);
    const stale = (await this.generations.pendingBefore(tenantId, "video", cutoff)).filter((g) => !this.running.has(g.id));
    for (const g of stale) {
      const won = await this.generations.finishPending(g.id, { status: "FAILED", error: TIMED_OUT, creditsUsed: 0 });
      if (won) await this.credits.refund({ tenantId, cost: g.creditsUsed, reason: "AI_VIDEO", userId: g.userId, refId: g.id }).catch((e) => console.error(`[ai] refund for ${g.id} failed:`, e));
    }
  }

  // للاختبارات: نستنى كل الفيديوهات اللي شغالة تخلص
  async whenIdle() {
    await Promise.all([...this.running.values()]);
  }
}
