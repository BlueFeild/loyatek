import { InsufficientCreditsError, NotFoundError, ValidationError } from "../../core/errors";
import type { CreditStore } from "./credit.repository";

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
    if (!Number.isInteger(req.cost) || req.cost < 0) throw new ValidationError("Invalid cost");
    const { balance, unlimited } = await this.getBalance(req.tenantId);
    const movement = { tenantId: req.tenantId, amount: -req.cost, reason: req.reason, refId: req.refId, createdById: req.userId };
    if (unlimited) {
      await this.repo.logOnly({ ...movement, note: "platform owner — not charged" }, balance);
      return balance;
    }
    const after = await this.repo.apply(movement);
    if (after === null) throw new InsufficientCreditsError(req.cost, balance);
    return after;
  }

  // ترجيع النقاط لو العملية فشلت بعد الخصم
  async refund(req: SpendRequest): Promise<void> {
    const { unlimited } = await this.getBalance(req.tenantId);
    if (unlimited || req.cost === 0) return;
    await this.repo.apply({ tenantId: req.tenantId, amount: req.cost, reason: "REFUND", note: req.reason, refId: req.refId, createdById: req.userId });
  }

  async grant(tenantId: string, amount: number, byUserId: string, note?: string): Promise<number> {
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) throw new ValidationError("Amount must be a whole number (not 0)");
    await this.getBalance(tenantId);
    const after = await this.repo.apply({ tenantId, amount, reason: amount > 0 ? "GRANT" : "DEDUCT", note: note ?? null, createdById: byUserId });
    if (after === null) throw new ValidationError("The company doesn't have that many credits to remove");
    return after;
  }

  history(tenantId: string) {
    return this.repo.history(tenantId);
  }
}
