import { randomUUID } from "crypto";
import { NotFoundError, ServiceUnavailableError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { AssetStore } from "./ai-asset.repository";
import type { GenerationStore } from "./ai-generation.repository";
import type { BusinessProfileReader } from "./business-profile.repository";
import { AI_COSTS } from "./ai-pricing";
import type { ImageBrief, ImageGenerator } from "./media-types";

// صانع الصور: يخصم الأول ← يولّد ← يحفظ الصورة (لو حاجة فشلت النقاط بترجع)
export class ImageStudioService {
  constructor(
    private readonly generator: ImageGenerator | null,
    private readonly credits: CreditService,
    private readonly generations: GenerationStore,
    private readonly assets: AssetStore,
    private readonly profiles: BusinessProfileReader
  ) {}

  get isAvailable(): boolean {
    return this.generator !== null;
  }

  async create(tenantId: string, userId: string | null, brief: ImageBrief) {
    const generator = this.generator;
    if (!generator) throw new ServiceUnavailableError("AI images aren't set up yet — please contact support.");
    const business = await this.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const cost = AI_COSTS.image;
    const id = randomUUID();
    const { result: asset, balance } = await this.credits.chargeFor({ tenantId, cost, reason: "AI_IMAGE", userId, refId: id }, async () => {
      const media = await generator.generate(brief, business);
      // صورة المنتج نفسها مابتتخزنش في السجل (حجمها كبير) - بنسجل إنها اتبعتت بس
      const { productImage, ...rest } = brief;
      await this.generations.create({
        id,
        tenantId,
        userId,
        tool: "image",
        kind: brief.scene,
        input: { ...rest, withProductPhoto: Boolean(productImage) },
        output: {},
        creditsUsed: cost,
        model: generator.model,
      });
      return this.assets.save({ tenantId, generationId: id, kind: "image", mimeType: media.mimeType, base64: media.base64 });
    });
    return { id, assetId: asset.id, creditsUsed: cost, balance };
  }

  history(tenantId: string) {
    return this.generations.recent(tenantId, "image");
  }
}
