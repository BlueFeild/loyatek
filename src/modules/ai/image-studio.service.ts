import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { AssetStore } from "./ai-asset.repository";
import type { GenerationStore } from "./ai-generation.repository";
import { AI_COSTS } from "./ai-pricing";
import type { ImageBrief, ImageGenerator } from "./media-types";

// صانع الصور: يتأكد من الرصيد ← يولّد ← يحفظ الصورة ← يخصم (بعد النجاح بس)
export class ImageStudioService {
  constructor(
    private readonly generator: ImageGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly assets: AssetStore
  ) {}

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async create(tenantId: string, userId: string | null, brief: ImageBrief) {
    if (!this.generator) throw new ServiceUnavailableError("AI images aren't set up yet — please contact support.");
    const cost = AI_COSTS.image;
    await this.credits.ensureCanSpend(tenantId, cost);
    const business = await this.generations.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const media = await this.generator.generate(brief, business);
    // صورة المنتج نفسها مابتتخزنش في السجل (حجمها كبير) - بنسجل إنها اتبعتت بس
    const { productImage, ...rest } = brief;
    const saved = await this.generations.create({
      tenantId,
      userId,
      tool: "image",
      kind: brief.scene,
      input: { ...rest, withProductPhoto: Boolean(productImage) },
      output: {},
      creditsUsed: cost,
      model: this.generator.model,
    });
    const asset = await this.assets.save({ tenantId, generationId: saved.id, kind: "image", mimeType: media.mimeType, base64: media.base64 });
    const balance = await this.credits.spend({ tenantId, cost, reason: "AI_IMAGE", userId, refId: saved.id });
    return { id: saved.id, assetId: asset.id, creditsUsed: cost, balance };
  }

  history(tenantId: string) {
    return this.generations.recent(tenantId, "image");
  }
}
