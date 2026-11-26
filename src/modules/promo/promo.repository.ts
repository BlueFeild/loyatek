import type { Prisma, PrismaClient } from "@prisma/client";
import type { PromoService } from "./promo.logic";

type Tx = Prisma.TransactionClient;

// كل كلام Prisma بتاع أكواد الخصم هنا بس - وكل استعلام متفلتر بالـ tenantId
export class PrismaPromoRepository {
  constructor(private readonly db: PrismaClient) {}

  list(tenantId: string, service: PromoService) {
    return this.db.promoCode.findMany({ where: { tenantId, service }, orderBy: { createdAt: "desc" } });
  }

  // مجموع الخصم اللي اتدى بكل كود (للتقرير الصغير جنب كل كود)
  async discountTotals(tenantId: string, promoIds: string[]) {
    if (promoIds.length === 0) return new Map<string, number>();
    const rows = await this.db.promoRedemption.groupBy({ by: ["promoId"], where: { tenantId, promoId: { in: promoIds } }, _sum: { discountUsd: true } });
    return new Map(rows.map((r) => [r.promoId, Number(r._sum.discountUsd ?? 0)]));
  }

  count(tenantId: string, service: PromoService) {
    return this.db.promoCode.count({ where: { tenantId, service } });
  }

  find(tenantId: string, service: PromoService, id: string) {
    return this.db.promoCode.findFirst({ where: { id, tenantId, service } });
  }

  findByCode(tenantId: string, service: PromoService, code: string) {
    return this.db.promoCode.findUnique({ where: { tenantId_service_code: { tenantId, service, code } } });
  }

  // فيه كود شغال للخدمة دي؟ (عشان الصفحة العامة تعرض خانة "عندك كود خصم؟")
  async hasLive(tenantId: string, service: PromoService, now: Date) {
    const n = await this.db.promoCode.count({
      where: {
        tenantId,
        service,
        active: true,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
    });
    return n > 0;
  }

  create(data: Prisma.PromoCodeUncheckedCreateInput) {
    return this.db.promoCode.create({ data });
  }

  update(tenantId: string, id: string, data: Prisma.PromoCodeUpdateManyMutationInput) {
    return this.db.promoCode.updateMany({ where: { id, tenantId }, data });
  }

  delete(tenantId: string, id: string) {
    return this.db.promoCode.deleteMany({ where: { id, tenantId } });
  }

  // حجز استخدام واحد بشكل ذرّي: بينجح بس لو الكود لسه شغال وفيه استخدامات باقية.
  // جوه نفس الـ transaction بتاعة الحجز/الطلب → لو الطلب فشل كل حاجة بترجع
  claim(tx: Tx, tenantId: string, promoId: string) {
    return tx.$executeRaw`UPDATE "promo_codes" SET "usedCount" = "usedCount" + 1, "updatedAt" = now()
      WHERE "id" = ${promoId} AND "tenantId" = ${tenantId} AND "active" = true
        AND ("maxUses" IS NULL OR "usedCount" < "maxUses")
        AND ("startsAt" IS NULL OR "startsAt" <= now())
        AND ("endsAt" IS NULL OR "endsAt" > now())`;
  }

  recordRedemption(tx: Tx, data: { tenantId: string; promoId: string; orderType: PromoService; orderId: string; discountUsd: number }) {
    return tx.promoRedemption.create({ data });
  }

  // الطلب/الحجز اتلغى: الاستخدام يرجع مرة واحدة بس (مسح السطر هو القفل)
  async release(tenantId: string, orderType: PromoService, orderId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const r = await tx.promoRedemption.findFirst({ where: { tenantId, orderType, orderId } });
      if (!r) return false;
      const del = await tx.promoRedemption.deleteMany({ where: { id: r.id } });
      if (del.count === 0) return false;
      await tx.$executeRaw`UPDATE "promo_codes" SET "usedCount" = GREATEST("usedCount" - 1, 0), "updatedAt" = now() WHERE "id" = ${r.promoId} AND "tenantId" = ${tenantId}`;
      return true;
    });
  }
}
