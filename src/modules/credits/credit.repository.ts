import { Prisma, PrismaClient } from "@prisma/client";

export interface CreditMovement {
  tenantId: string;
  amount: number; // موجب = إضافة، سالب = خصم
  reason: string;
  note?: string | null;
  refId?: string | null;
  createdById?: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

// اللي الخدمة محتاجاه من التخزين (أي تخزين يطبّقه - Prisma أو نسخة في الذاكرة للاختبار)
export interface CreditStore {
  balance(tenantId: string): Promise<{ balance: number; isPlatformOwner: boolean } | null>;
  apply(m: CreditMovement): Promise<number | null>;
  logOnly(m: CreditMovement, balanceAfter: number): Promise<void>;
  history(tenantId: string): Promise<unknown[]>;
}

// الوصول لقاعدة البيانات بس - مفيش منطق هنا
export class CreditRepository implements CreditStore {
  constructor(private readonly db: PrismaClient) {}

  async balance(tenantId: string): Promise<{ balance: number; isPlatformOwner: boolean } | null> {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { creditBalance: true, isPlatformOwner: true } });
    return t ? { balance: t.creditBalance, isPlatformOwner: t.isPlatformOwner } : null;
  }

  // إضافة/خصم ذرّي: الخصم مايعديش الرصيد تحت الصفر حتى لو طلبين في نفس اللحظة
  async apply(m: CreditMovement): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
      const where: Prisma.TenantWhereInput = { id: m.tenantId };
      if (m.amount < 0) where.creditBalance = { gte: -m.amount };
      const updated = await tx.tenant.updateMany({ where, data: { creditBalance: { increment: m.amount } } });
      if (updated.count === 0) return null;
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: m.tenantId }, select: { creditBalance: true } });
      await this.log(tx, m, t.creditBalance);
      return t.creditBalance;
    });
  }

  // عمليات من غير خصم (شركة المنصة مجانية) بتتسجل برضه عشان نعرف الاستهلاك
  async logOnly(m: CreditMovement, balanceAfter: number): Promise<void> {
    await this.log(this.db, m, balanceAfter);
  }

  history(tenantId: string, take = 30) {
    return this.db.creditTransaction.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take });
  }

  private async log(db: Db, m: CreditMovement, balanceAfter: number) {
    await db.creditTransaction.create({
      data: { tenantId: m.tenantId, amount: m.amount, balanceAfter, reason: m.reason, note: m.note ?? null, refId: m.refId ?? null, createdById: m.createdById ?? null },
    });
  }
}
