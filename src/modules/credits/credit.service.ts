import { InsufficientCreditsError, NotFoundError, ValidationError } from "../../core/errors";
import type { CreditMovement, CreditStore } from "./credit.repository";

export interface SpendRequest {
  tenantId: string;
  cost: number;
  reason: string;
  userId?: string | null;
  refId?: string | null;
}

// رصيد النقاط: أي خدمة بتتكلّف (ذكاء اصطناعي / SMS / تحليل) بتخصم من هنا بس.
// شركة المنصة (isPlatformOwner) مابتتخصمش منها حاجة، بس الاستهلاك بيتسجل
export class CreditService {
  constructor(private readonly repo: CreditStore) {}

  async getBalance(tenantId: string): Promise<{ balance: number; unlimited: boolean }> {
    const b = await this.repo.balance(tenantId);
    if (!b) throw new NotFoundError("Company not found");
    return { balance: b.balance, unlimited: b.isPlatformOwner };
  }

  async ensureCanSpend(tenantId: string, cost: number): Promise<void> {
    const { balance, unlimited } = await this.getBalance(tenantId);
    if (!unlimited && balance < cost) throw new InsufficientCreditsError(cost, balance);
  }

  async spend(req: SpendRequest): Promise<number> {
    const { balance, unlimited } = await this.debit(req);
    if (unlimited) await this.logUnlimited(req, balance);
    return balance;
  }

  // ادفع الأول ← اشتغل ← لو الشغل فشل النقاط ترجع والخطأ يكمّل لفوق.
  // كده مستحيل حد ياخد نتيجة من غير ما يدفع (حتى لو بعت طلبات كتير في نفس اللحظة).
  // شركة المنصة: مفيش خصم، والاستهلاك بيتسجل بعد النجاح بس
  async chargeFor<T>(req: SpendRequest, work: () => Promise<T>): Promise<{ result: T; balance: number }> {
    const { balance, unlimited } = await this.debit(req);
    let result: T;
    try {
      result = await work();
    } catch (err) {
      if (!unlimited) await this.refund(req).catch((e) => console.error(`[credits] refund of ${req.reason} (${req.refId ?? "-"}) failed:`, e));
      throw err;
    }
    if (unlimited) await this.logUnlimited(req, balance).catch((e) => console.error("[credits] usage log failed:", e));
    return { result, balance };
  }

  // ترجيع النقاط لو العملية فشلت بعد الخصم
  async refund(req: SpendRequest): Promise<void> {
    const { unlimited } = await this.getBalance(req.tenantId);
    if (unlimited || req.cost === 0) return;
    await this.repo.apply({ tenantId: req.tenantId, amount: req.cost, reason: "REFUND", note: req.reason, refId: req.refId, createdById: req.userId });
  }

  // createdById = null يعني النظام نفسه (تجربة / اشتراك)، مش يوزر
  async grant(tenantId: string, amount: number, byUserId: string | null, note?: string, reason?: string, refId?: string): Promise<number> {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new ValidationError("Amount must be a whole number (not 0)");
    await this.getBalance(tenantId);
    const after = await this.repo.apply({ tenantId, amount, reason: reason ?? (amount > 0 ? "GRANT" : "DEDUCT"), note: note ?? null, refId: refId ?? null, createdById: byUserId });
    if (after === null) throw new ValidationError("The company doesn't have that many credits to remove");
    return after;
  }

  history(tenantId: string) {
    return this.repo.history(tenantId);
  }

  // الخصم الذرّي نفسه (شركة المنصة: مفيش خصم)
  private async debit(req: SpendRequest): Promise<{ balance: number; unlimited: boolean }> {
    if (!Number.isInteger(req.cost) || req.cost < 0) throw new ValidationError("Invalid cost");
    const { balance, unlimited } = await this.getBalance(req.tenantId);
    if (unlimited) return { balance, unlimited };
    const after = await this.repo.apply(this.movement(req));
    if (after === null) throw new InsufficientCreditsError(req.cost, balance);
    return { balance: after, unlimited };
  }

  private logUnlimited(req: SpendRequest, balance: number) {
    return this.repo.logOnly({ ...this.movement(req), note: "platform owner — not charged" }, balance);
  }

  private movement(req: SpendRequest): CreditMovement {
    return { tenantId: req.tenantId, amount: -req.cost, reason: req.reason, refId: req.refId, createdById: req.userId };
  }
}
