import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { AppError, NotFoundError } from "../../core/errors";
import type { PrismaPromoRepository } from "./promo.repository";
import {
  MAX_PROMOS_PER_SERVICE,
  normalizePromoCode,
  promoDiscount,
  promoProblem,
  promoProblemMessage,
  totalAfterPromo,
  type PromoRule,
  type PromoService,
  type promoInput,
  type promoPatch,
} from "./promo.logic";

type Tx = Prisma.TransactionClient;
type Row = NonNullable<Awaited<ReturnType<PrismaPromoRepository["find"]>>>;

// كود اتقبل على مبلغ معيّن - بيتبعت لـ redeem() جوه transaction الحجز/الطلب
export interface AppliedPromo {
  promoId: string;
  code: string;
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
}

// بيعرض الدولار بعملة الشركة (للرسايل زي "اصرف على الأقل ...")
export type MoneyFormatter = (tenantId: string) => Promise<(usd: number) => string>;

const toRule = (r: Row): PromoRule => ({
  id: r.id,
  code: r.code,
  kind: r.kind,
  value: Number(r.value),
  minOrderUsd: r.minOrderUsd == null ? null : Number(r.minOrderUsd),
  maxUses: r.maxUses,
  usedCount: r.usedCount,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  active: r.active,
});

export class PromoCodeService {
  constructor(
    private readonly repo: PrismaPromoRepository,
    private readonly money: MoneyFormatter
  ) {}

  private view(r: Row, discountGivenUsd = 0) {
    const rule = toRule(r);
    const now = new Date();
    const state = !r.active ? "off" : r.startsAt && r.startsAt > now ? "scheduled" : r.endsAt && r.endsAt <= now ? "expired" : r.maxUses != null && r.usedCount >= r.maxUses ? "used_up" : "live";
    return { ...rule, service: r.service, createdAt: r.createdAt, discountGivenUsd, state };
  }

  async list(tenantId: string, service: PromoService) {
    const rows = await this.repo.list(tenantId, service);
    const totals = await this.repo.discountTotals(tenantId, rows.map((r) => r.id));
    return rows.map((r) => this.view(r, totals.get(r.id) ?? 0));
  }

  async create(tenantId: string, service: PromoService, input: z.infer<typeof promoInput>) {
    if ((await this.repo.count(tenantId, service)) >= MAX_PROMOS_PER_SERVICE) throw new AppError(400, "TOO_MANY", `Up to ${MAX_PROMOS_PER_SERVICE} codes.`);
    try {
      const row = await this.repo.create({
        tenantId,
        service,
        code: input.code,
        kind: input.kind,
        value: input.value,
        minOrderUsd: input.minOrderUsd || null,
        maxUses: input.maxUses ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        active: input.active ?? true,
      });
      return this.view(row);
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new AppError(409, "PROMO_EXISTS", "You already have a code with this name.");
      throw e;
    }
  }

  async update(tenantId: string, service: PromoService, id: string, patch: z.infer<typeof promoPatch>) {
    const current = await this.repo.find(tenantId, service, id);
    if (!current) throw new NotFoundError("Code not found");
    const kind = patch.kind ?? current.kind;
    const value = patch.value ?? Number(current.value);
    if (kind === "PERCENT" && value > 100) throw new AppError(400, "VALIDATION_ERROR", "A percentage can't be more than 100");
    const startsAt = patch.startsAt !== undefined ? patch.startsAt : current.startsAt;
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : current.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) throw new AppError(400, "VALIDATION_ERROR", "The end date must be after the start date");
    const data: Prisma.PromoCodeUpdateManyMutationInput = {};
    if (patch.code !== undefined) data.code = patch.code;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.value !== undefined) data.value = patch.value;
    if (patch.minOrderUsd !== undefined) data.minOrderUsd = patch.minOrderUsd || null;
    if (patch.maxUses !== undefined) data.maxUses = patch.maxUses;
    if (patch.startsAt !== undefined) data.startsAt = patch.startsAt;
    if (patch.endsAt !== undefined) data.endsAt = patch.endsAt;
    if (patch.active !== undefined) data.active = patch.active;
    try {
      await this.repo.update(tenantId, id, data);
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new AppError(409, "PROMO_EXISTS", "You already have a code with this name.");
      throw e;
    }
    const row = await this.repo.find(tenantId, service, id);
    const totals = await this.repo.discountTotals(tenantId, [id]);
    return this.view(row!, totals.get(id) ?? 0);
  }

  async remove(tenantId: string, service: PromoService, id: string) {
    const current = await this.repo.find(tenantId, service, id);
    if (!current) throw new NotFoundError("Code not found");
    await this.repo.delete(tenantId, id);
  }

  hasLive(tenantId: string, service: PromoService, now = new Date()) {
    return this.repo.hasLive(tenantId, service, now);
  }

  // الكود + المبلغ → خصم (أو خطأ 400 برسالة واضحة). كود مش موجود = نفس رسالة "مش صالح"
  async resolve(tenantId: string, service: PromoService, rawCode: string, subtotalUsd: number, now = new Date()): Promise<AppliedPromo> {
    const code = normalizePromoCode(rawCode);
    const row = code ? await this.repo.findByCode(tenantId, service, code) : null;
    if (!row) throw new AppError(400, "PROMO_INVALID", "This code isn't valid.");
    const rule = toRule(row);
    const problem = promoProblem(rule, subtotalUsd, now);
    if (problem) {
      const fmt = await this.money(tenantId);
      throw new AppError(400, problem.code, promoProblemMessage(problem, fmt));
    }
    const discountUsd = promoDiscount(rule, subtotalUsd);
    return { promoId: row.id, code: row.code, subtotalUsd, discountUsd, totalUsd: totalAfterPromo(subtotalUsd, discountUsd) };
  }

  // فحص من الصفحة العامة (من غير ما يحجز استخدام). مابيرميش أخطاء
  async check(tenantId: string, service: PromoService, rawCode: string, subtotalUsd: number | null, now = new Date()) {
    try {
      const sub = subtotalUsd ?? 0;
      if (subtotalUsd == null) {
        // من غير مبلغ: بس نتأكد إن الكود شغال
        const row = await this.repo.findByCode(tenantId, service, normalizePromoCode(rawCode));
        if (!row) return { valid: false as const, code: "PROMO_INVALID", message: "This code isn't valid." };
        const problem = promoProblem(toRule(row), null, now);
        if (problem) return { valid: false as const, code: problem.code, message: promoProblemMessage(problem, await this.money(tenantId)) };
        return { valid: true as const, code: row.code, kind: row.kind, value: Number(row.value), minOrderUsd: row.minOrderUsd == null ? null : Number(row.minOrderUsd), discountUsd: null, totalUsd: null, message: null };
      }
      const a = await this.resolve(tenantId, service, rawCode, sub, now);
      const row = (await this.repo.find(tenantId, service, a.promoId))!;
      return { valid: true as const, code: a.code, kind: row.kind, value: Number(row.value), minOrderUsd: row.minOrderUsd == null ? null : Number(row.minOrderUsd), discountUsd: a.discountUsd, totalUsd: a.totalUsd, message: null };
    } catch (e) {
      if (e instanceof AppError) return { valid: false as const, code: e.code, message: e.message };
      throw e;
    }
  }

  // جوه transaction الحجز/الطلب: يحجز استخدام + يسجّله على الطلب. لو آخر استخدام راح لحد تاني
  // في نفس اللحظة → 409، والـ transaction كلها بترجع (الحجز مايتعملش)
  async redeem(tx: Tx, tenantId: string, service: PromoService, applied: AppliedPromo, orderId: string) {
    const claimed = await this.repo.claim(tx, tenantId, applied.promoId);
    if (claimed === 0) throw new AppError(409, "PROMO_USED_UP", "This code has just been fully used — remove it to continue.");
    await this.repo.recordRedemption(tx, { tenantId, promoId: applied.promoId, orderType: service, orderId, discountUsd: applied.discountUsd });
  }

  // الحجز/الطلب اتلغى → الاستخدام يرجع (مرة واحدة بس). مابيوقفش الإلغاء لو حصل خطأ
  async release(tenantId: string, service: PromoService, orderId: string) {
    try {
      return await this.repo.release(tenantId, service, orderId);
    } catch (e) {
      console.error("[promo] release failed", (e as Error).message);
      return false;
    }
  }
}
