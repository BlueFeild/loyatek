import { prisma } from "../../config/db";

const STAGE_ORDER = ["LEAD", "QUALIFIED", "PROPOSAL", "WON"] as const;

export function nextStage(current: string): string | null {
  const idx = STAGE_ORDER.indexOf(current as (typeof STAGE_ORDER)[number]);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null; // WON أو LOST مراحل نهائية
  return STAGE_ORDER[idx + 1];
}

// تحريك صفقة للمرحلة الجاية + تسجيل النشاط تلقائيًا في Timeline العميل -
// سوا جوه transaction واحدة عشان الاتنين يحصلوا مع بعض أو محدش
export async function advanceDeal(tenantId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
  if (!deal) throw new Error("Deal not found");

  const next = nextStage(deal.stage);
  if (!next) throw new Error(`Deal is already at a final stage (${deal.stage})`);

  const [updatedDeal] = await prisma.$transaction([
    prisma.deal.update({ where: { id: dealId }, data: { stage: next as "LEAD" | "QUALIFIED" | "PROPOSAL" | "WON" } }),
    prisma.activity.create({
      data: {
        tenantId,
        customerId: deal.customerId,
        type: "STAGE_CHANGE",
        text: `Deal "${deal.name}" moved from ${deal.stage} to ${next}`,
      },
    }),
  ]);

  return updatedDeal;
}

export async function markDealLost(tenantId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId } });
  if (!deal) throw new Error("Deal not found");
  if (deal.stage === "WON" || deal.stage === "LOST") {
    throw new Error(`Deal is already at a final stage (${deal.stage})`);
  }

  const [updatedDeal] = await prisma.$transaction([
    prisma.deal.update({ where: { id: dealId }, data: { stage: "LOST" } }),
    prisma.activity.create({
      data: {
        tenantId,
        customerId: deal.customerId,
        type: "STAGE_CHANGE",
        text: `Deal "${deal.name}" marked as Lost from ${deal.stage}`,
      },
    }),
  ]);

  return updatedDeal;
}
