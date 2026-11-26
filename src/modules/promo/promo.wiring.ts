import { prisma } from "../../config/db";
import { formatUsdAs, getTenantMoney } from "../../utils/money";
import { PrismaPromoRepository } from "./promo.repository";
import { PromoCodeService } from "./promo.service";

// التوصيل هنا (مش في core/container.ts) لأن bookings.service و catalog.service بيستخدموه،
// والـ container نفسه بيستورد حاجات بتستورد bookings.service → كان هيعمل circular import.
export const promoCodes = new PromoCodeService(new PrismaPromoRepository(prisma), async (tenantId) => {
  const m = await getTenantMoney(tenantId);
  return (usd: number) => formatUsdAs(usd, m.currency, m.rates);
});
