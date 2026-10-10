import { prisma } from "../../config/db";
import { getOrCreateWalletSettings } from "./wallet.service";
import { computeStamp } from "./stamp-logic";

export class WalletFlowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Actor {
  userId: string;
  name: string;
}

// اسم الموظف بيتسجّل وقت الحركة في سجل المراجعة
export async function resolveActor(userId: string): Promise<Actor> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return { userId, name: user?.name ?? "Unknown staff" };
}

// نسخة العميل اللي بترجع للموظف - من غير memberCode، لأنه الكود نفسه
// اللي الموظف لسه ماسحه، ومالوش لازمة يرجع تاني
function customerView(c: { id: string; name: string; phone: string; balance: number; tier: string; lastVisitAt: Date | null }) {
  return { id: c.id, name: c.name, phone: c.phone, balance: c.balance, tier: c.tier, lastVisitAt: c.lastVisitAt };
}

async function rewardsView(customerId: string, db: any = prisma) {
  const rows = await db.walletReward.findMany({
    where: { customerId, status: "AVAILABLE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, createdAt: true },
  });
  return rows as { id: string; label: string; createdAt: Date }[];
}

// "Scan" - بحث بالكود بس، من غير أي تغيير. الموظف بيشوف العميل ورصيده
// وهداياه قبل ما يضغط ختم أو تسليم
export async function scanByCode(tenantId: string, code: string) {
  const customer = await prisma.walletCustomer.findFirst({ where: { tenantId, memberCode: code.trim() } });
  if (!customer) throw new WalletFlowError("This code doesn't belong to any member of your loyalty program", 404);

  const settings = await getOrCreateWalletSettings(tenantId);
  return {
    customer: customerView(customer),
    engine: settings.engine,
    stampCount: settings.stampCount,
    rewardText: settings.rewardText,
    availableRewards: await rewardsView(customer.id),
  };
}

// إضافة ختم - لازم الكود نفسه (اللي بيظهر عند العميل)، مش الـ id ولا
// رقم التليفون؛ يعني من غير ما العميل يكون موجود وكوده معاه الموظف مش
// هيقدر يختم. القفل (FOR UPDATE) بيمنع ضغطتين في نفس اللحظة من إنهم
// يتخطّوا بعض ويضيّعوا ختم أو هدية
export async function addStampByCode(tenantId: string, code: string, actor: Actor) {
  const settings = await getOrCreateWalletSettings(tenantId);
  if (settings.engine !== "stamp") {
    throw new WalletFlowError(
      `Scan-to-stamp works with the "Stamp" loyalty type, but this program is set to "${settings.engine}". Change it in the Wallet settings first.`,
      400
    );
  }

  return prisma.$transaction(async (tx: any) => {
    const found = await tx.walletCustomer.findFirst({ where: { tenantId, memberCode: code.trim() } });
    if (!found) throw new WalletFlowError("This code doesn't belong to any member of your loyalty program", 404);

    await tx.$queryRaw`SELECT id FROM wallet_customers WHERE id = ${found.id} FOR UPDATE`;
    const customer = await tx.walletCustomer.findUnique({ where: { id: found.id } });

    const { balance, rewardsEarned } = computeStamp(customer.balance, settings.stampCount);
    const updated = await tx.walletCustomer.update({
      where: { id: customer.id },
      data: { balance, lastVisitAt: new Date() },
    });

    await tx.walletEvent.create({
      data: { tenantId, customerId: customer.id, type: "STAMP", delta: 1, actorUserId: actor.userId, actorName: actor.name },
    });

    for (let i = 0; i < rewardsEarned; i++) {
      await tx.walletReward.create({ data: { tenantId, customerId: customer.id, label: settings.rewardText } });
      await tx.walletEvent.create({
        data: {
          tenantId,
          customerId: customer.id,
          type: "REWARD_EARNED",
          note: settings.rewardText,
          actorUserId: actor.userId,
          actorName: actor.name,
        },
      });
    }

    return {
      customer: customerView(updated),
      engine: settings.engine,
      stampCount: settings.stampCount,
      rewardText: settings.rewardText,
      rewardsEarned,
      availableRewards: await rewardsView(customer.id, tx),
    };
  });
}

// تسليم هدية - بردو بالكود نفسه، وبيسلّم أقدم هدية متاحة
export async function redeemRewardByCode(tenantId: string, code: string, actor: Actor) {
  const settings = await getOrCreateWalletSettings(tenantId);

  return prisma.$transaction(async (tx: any) => {
    const found = await tx.walletCustomer.findFirst({ where: { tenantId, memberCode: code.trim() } });
    if (!found) throw new WalletFlowError("This code doesn't belong to any member of your loyalty program", 404);

    await tx.$queryRaw`SELECT id FROM wallet_customers WHERE id = ${found.id} FOR UPDATE`;

    const reward = await tx.walletReward.findFirst({
      where: { customerId: found.id, status: "AVAILABLE" },
      orderBy: { createdAt: "asc" },
    });
    if (!reward) throw new WalletFlowError("This member has no gift waiting to be redeemed", 400);

    const claimed = await tx.walletReward.updateMany({
      where: { id: reward.id, status: "AVAILABLE" },
      data: { status: "REDEEMED", redeemedAt: new Date(), redeemedByName: actor.name },
    });
    if (claimed.count !== 1) throw new WalletFlowError("This gift was just redeemed — please scan again", 409);

    await tx.walletEvent.create({
      data: {
        tenantId,
        customerId: found.id,
        type: "REWARD_REDEEMED",
        note: reward.label,
        actorUserId: actor.userId,
        actorName: actor.name,
      },
    });

    const customer = await tx.walletCustomer.findUnique({ where: { id: found.id } });
    return {
      customer: customerView(customer),
      engine: settings.engine,
      stampCount: settings.stampCount,
      rewardText: settings.rewardText,
      redeemedLabel: reward.label as string,
      availableRewards: await rewardsView(found.id, tx),
    };
  });
}

// آخر الحركات على كروت العملاء - للمدير/المالك عشان يراجع الموظفين
export async function listRecentActivity(tenantId: string, limit = 50) {
  const events = await prisma.walletEvent.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { customer: { select: { name: true, phone: true } } },
  });
  return events;
}
