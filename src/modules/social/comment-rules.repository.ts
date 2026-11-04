import { Prisma, PrismaClient } from "@prisma/client";

// اللي أتمتة التعليقات محتاجاه من التخزين (Prisma أو نسخة في الذاكرة للاختبار)

export interface CommentRule {
  id: string;
  accountId: string | null;
  name: string;
  keywords: string[];
  dmText: string;
  publicReply: string | null;
  enabled: boolean;
  sentCount: number;
  createdAt: Date;
}

export type CommentRuleInput = Pick<CommentRule, "accountId" | "name" | "keywords" | "dmText" | "publicReply" | "enabled">;

export interface CommentRuleStore {
  list(tenantId: string): Promise<CommentRule[]>;
  active(tenantId: string, accountId: string): Promise<CommentRule[]>;
  create(tenantId: string, input: CommentRuleInput): Promise<CommentRule>;
  update(tenantId: string, id: string, input: Partial<CommentRuleInput>): Promise<CommentRule | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
  accountBelongs(tenantId: string, accountId: string): Promise<boolean>;
  // قفل: الشخص ده خد الرسالة من القاعدة دي قبل كده؟ false = آه (ماتبعتش تاني)
  claimHit(ruleId: string, commentId: string, authorId: string): Promise<boolean>;
  finishHit(ruleId: string, commentId: string, ok: boolean, error: string | null): Promise<void>;
}

const select = { id: true, accountId: true, name: true, keywords: true, dmText: true, publicReply: true, enabled: true, sentCount: true, createdAt: true } as const;

// الوصول لقاعدة البيانات بس - مفيش منطق هنا
export class PrismaCommentRuleRepository implements CommentRuleStore {
  constructor(private readonly db: PrismaClient) {}

  list(tenantId: string) {
    return this.db.socialCommentRule.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, select });
  }

  active(tenantId: string, accountId: string) {
    return this.db.socialCommentRule.findMany({ where: { tenantId, enabled: true, OR: [{ accountId: null }, { accountId }] }, orderBy: { createdAt: "asc" }, select });
  }

  create(tenantId: string, input: CommentRuleInput) {
    return this.db.socialCommentRule.create({ data: { tenantId, ...input }, select });
  }

  async update(tenantId: string, id: string, input: Partial<CommentRuleInput>) {
    const r = await this.db.socialCommentRule.updateMany({ where: { id, tenantId }, data: input });
    return r.count ? this.db.socialCommentRule.findUnique({ where: { id }, select }) : null;
  }

  async delete(tenantId: string, id: string) {
    return (await this.db.socialCommentRule.deleteMany({ where: { id, tenantId } })).count > 0;
  }

  async accountBelongs(tenantId: string, accountId: string) {
    return (await this.db.socialAccount.count({ where: { id: accountId, tenantId } })) > 0;
  }

  async claimHit(ruleId: string, commentId: string, authorId: string) {
    try {
      await this.db.socialCommentRuleHit.create({ data: { ruleId, commentId, authorId } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  }

  async finishHit(ruleId: string, commentId: string, ok: boolean, error: string | null) {
    await this.db.socialCommentRuleHit.updateMany({ where: { ruleId, commentId }, data: { ok, error: error?.slice(0, 500) ?? null } });
    if (ok) await this.db.socialCommentRule.update({ where: { id: ruleId }, data: { sentCount: { increment: 1 } } });
  }
}
