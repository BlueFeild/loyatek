import { NotFoundError, ValidationError } from "../../core/errors";
import { keywordMatches } from "../whatsapp/bot";
import type { CommentRule, CommentRuleInput, CommentRuleStore } from "./comment-rules.repository";
import type { InboxAccount, InboxEvent, SocialInboxGateway } from "./social-types";

export const COMMENT_RULE_LIMITS = { maxRules: 30, maxKeywords: 20, maxDm: 1000, maxPublic: 500, maxName: 80 };

// القاعدة بتنطبق على التعليق ده؟ (من غير كلمات = أي تعليق)
export function ruleMatches(rule: Pick<CommentRule, "keywords">, text: string): boolean {
  if (rule.keywords.length === 0) return text.trim().length > 0;
  return rule.keywords.some((k) => keywordMatches(text, k));
}

// {name} = اسم صاحب التعليق. لو مش معروف بنشيل الكلمة والمسافة اللي قبلها ("Hi {name}!" ← "Hi!")
export function fillName(template: string, name: string | null): string {
  const n = (name ?? "").trim();
  return (n ? template.replace(/\{name\}/g, n) : template.replace(/\s*\{name\}/g, "")).trim();
}

// "اكتب كومنت فيه كلمة كذا وهنبعتلك اللينك": كومنت جديد على فيسبوك/انستجرام (من الـ webhook)
// ← رسالة خاصة لصاحبه (Private Reply) + رد على الكومنت لو التاجر كتب واحد. كل شخص مرة واحدة للقاعدة
export class CommentAutomationService {
  constructor(
    private readonly store: CommentRuleStore,
    private readonly gateway: SocialInboxGateway
  ) {}

  list(tenantId: string) {
    return this.store.list(tenantId);
  }

  async create(tenantId: string, input: CommentRuleInput) {
    const clean = await this.validate(tenantId, input);
    if ((await this.store.list(tenantId)).length >= COMMENT_RULE_LIMITS.maxRules) throw new ValidationError(`You can have up to ${COMMENT_RULE_LIMITS.maxRules} rules.`);
    return this.store.create(tenantId, clean);
  }

  async update(tenantId: string, id: string, input: Partial<CommentRuleInput>) {
    const current = (await this.store.list(tenantId)).find((r) => r.id === id);
    if (!current) throw new NotFoundError("Rule not found");
    const clean = await this.validate(tenantId, { ...current, ...input });
    const row = await this.store.update(tenantId, id, clean);
    if (!row) throw new NotFoundError("Rule not found");
    return row;
  }

  async remove(tenantId: string, id: string) {
    if (!(await this.store.delete(tenantId, id))) throw new NotFoundError("Rule not found");
    return { ok: true };
  }

  private async validate(tenantId: string, input: CommentRuleInput): Promise<CommentRuleInput> {
    const name = input.name.trim().slice(0, COMMENT_RULE_LIMITS.maxName);
    const dmText = input.dmText.trim();
    const publicReply = input.publicReply?.trim() || null;
    const keywords = [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))].slice(0, COMMENT_RULE_LIMITS.maxKeywords);
    if (!name) throw new ValidationError("Give the rule a name.");
    if (!dmText) throw new ValidationError("Write the private message people will get.");
    if (dmText.length > COMMENT_RULE_LIMITS.maxDm) throw new ValidationError(`Keep the private message under ${COMMENT_RULE_LIMITS.maxDm} characters.`);
    if (publicReply && publicReply.length > COMMENT_RULE_LIMITS.maxPublic) throw new ValidationError(`Keep the public reply under ${COMMENT_RULE_LIMITS.maxPublic} characters.`);
    if (input.accountId && !(await this.store.accountBelongs(tenantId, input.accountId))) throw new ValidationError("That account isn't connected to your company.");
    return { accountId: input.accountId ?? null, name, keywords, dmText, publicReply, enabled: input.enabled };
  }

  // تعليقات جديدة لحساب واحد (التعليقات اللي التاجر كتبها بنفسه بتتجاهل)
  async run(tenantId: string, accountId: string, account: InboxAccount, events: InboxEvent[]) {
    const comments = events.filter((e) => e.kind === "COMMENT" && e.direction === "IN" && e.authorId && e.authorId !== account.externalId);
    if (comments.length === 0) return { sent: 0 };
    const rules = await this.store.active(tenantId, accountId);
    if (rules.length === 0) return { sent: 0 };
    let sent = 0;
    for (const c of comments) {
      // أول قاعدة تنطبق بس (عشان الشخص مايوصلوش أكتر من رسالة على نفس التعليق)
      const rule = rules.find((r) => ruleMatches(r, c.text));
      if (!rule) continue;
      if (!(await this.store.claimHit(rule.id, c.externalId, c.authorId!))) continue;
      let ok = true;
      let error: string | null = null;
      try {
        if (!this.gateway.privateReply) throw new Error("Private replies aren't supported");
        await this.gateway.privateReply(account, c.externalId, fillName(rule.dmText, c.authorName));
        if (rule.publicReply) await this.gateway.replyToComment(account, c.externalId, fillName(rule.publicReply, c.authorName)).catch((e) => console.warn(`[social-auto] public reply failed: ${(e as Error)?.message}`));
        sent++;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : "failed";
        console.warn(`[social-auto] private reply failed (rule ${rule.id}): ${error}`);
      }
      await this.store.finishHit(rule.id, c.externalId, ok, error);
    }
    return { sent };
  }
}
