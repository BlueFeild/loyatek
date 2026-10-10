import { prisma } from "../../config/db";

export async function getOrCreateWalletSettings(tenantId: string) {
  const existing = await prisma.walletSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.walletSettings.create({ data: { tenantId } });
}

interface UpdateWalletSettingsInput {
  engine?: string;
  stampCount?: number;
  pointsRate?: number;
  cashbackPct?: number;
  expirationDays?: number;
  rewardText?: string;
  allowOverrides?: boolean;
  cardLayout?: string;
  themeColor?: string;
  logoDataUrl?: string | null;
  centerLabel?: string;
  centerIconDataUrl?: string | null;
  centerBorderThickness?: number;
  centerRingColor?: string;
  centerInnerGlow?: boolean;
  showDecorCircles?: boolean;
  decorCircles?: unknown;
  termsText?: string;
}

export async function updateWalletSettings(tenantId: string, data: UpdateWalletSettingsInput) {
  await getOrCreateWalletSettings(tenantId);
  return prisma.walletSettings.update({ where: { tenantId }, data: data as any });
}

// تعديل رصيد نقاط عميل - بيمنع الرصيد يروح تحت الصفر، وبيتسجّل في سجل
// المراجعة باسم الموظف اللي عدّل (بالفرق الفعلي اللي حصل مش المطلوب)
export async function adjustCustomerBalance(
  tenantId: string,
  customerId: string,
  delta: number,
  actor?: { userId: string; name: string }
) {
  const customer = await prisma.walletCustomer.findFirst({ where: { id: customerId, tenantId } });
  if (!customer) throw new Error("Customer not found");

  const nextBalance = Math.max(0, customer.balance + delta);
  const [updated] = await prisma.$transaction([
    prisma.walletCustomer.update({
      where: { id: customerId },
      data: { balance: nextBalance, lastVisitAt: new Date() },
    }),
    prisma.walletEvent.create({
      data: {
        tenantId,
        customerId,
        type: "ADJUST",
        delta: nextBalance - customer.balance,
        note: "Manual balance adjustment",
        actorUserId: actor?.userId ?? null,
        actorName: actor?.name ?? null,
      },
    }),
  ]);
  return updated;
}
