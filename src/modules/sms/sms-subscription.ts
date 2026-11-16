// اشتراك الـ SMS بيشمل رصيد رسايل: 200 في الشهر (×12 للسنوي)، بيتضاف مرة واحدة لكل طلب
// جوه نفس transaction تفعيل الطلب (القفل هناك بيضمن مرة واحدة). refId = رقم الطلب
export const SMS_MONTHLY_INCLUDED = 200;

export function includedSms(billingCycle: string): number {
  return billingCycle === "yearly" ? SMS_MONTHLY_INCLUDED * 12 : SMS_MONTHLY_INCLUDED;
}

// tx = Prisma transaction client (أو أي حاجة بنفس الشكل في الاختبارات)
export interface SmsCreditTx {
  smsCreditTransaction: {
    findFirst(args: { where: { tenantId: string; reason: string; refId: string } }): Promise<unknown>;
    create(args: { data: { tenantId: string; amount: number; reason: string; refId: string; note: string } }): Promise<unknown>;
  };
  smsSettings: {
    upsert(args: { where: { tenantId: string }; create: { tenantId: string; balance: number }; update: { balance: { increment: number } } }): Promise<unknown>;
  };
}

export async function grantIncludedSms(tx: SmsCreditTx, tenantId: string, billingCycle: string, orderId: string): Promise<number> {
  const amount = includedSms(billingCycle);
  // احتياط زيادة: لو الطلب ده اتضاف رصيده قبل كده مانضيفش تاني
  if (await tx.smsCreditTransaction.findFirst({ where: { tenantId, reason: "SUBSCRIPTION", refId: orderId } })) return 0;
  await tx.smsSettings.upsert({ where: { tenantId }, create: { tenantId, balance: amount }, update: { balance: { increment: amount } } });
  await tx.smsCreditTransaction.create({ data: { tenantId, amount, reason: "SUBSCRIPTION", refId: orderId, note: `SMS subscription (order ${orderId.slice(0, 8)})` } });
  return amount;
}
