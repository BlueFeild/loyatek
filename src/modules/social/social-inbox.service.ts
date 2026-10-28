import { randomUUID } from "crypto";
import { AppError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../core/errors";
import type { CreditService } from "../credits/credit.service";
import type { GenerationStore } from "../ai/ai-generation.repository";
import type { BusinessProfileReader } from "../ai/business-profile.repository";
import type { CopyBrief, CopyGenerator } from "../ai/copy-generator";
import { AI_COSTS } from "../ai/ai-pricing";
import type { InboxAccountRow, InboxStore } from "./social-inbox.repository";
import { DM_REPLY_WINDOW_MS, SocialPlatformError, type InboxEvent, type InboxKind, type SocialInboxGateway } from "./social-types";
import { decryptToken } from "./token-crypto";
import { parseSocialWebhook } from "./social-webhook.parser";

export interface ThreadRef {
  accountId: string;
  kind: InboxKind;
  threadKey: string;
}

// صندوق تعليقات ورسايل فيسبوك/انستجرام: بيستقبل من الـ webhook أو المزامنة، والتاجر بيرد
// (والذكاء الاصطناعي بيقترح الرد بنقطة واحدة)
export class SocialInboxService {
  constructor(
    private readonly store: InboxStore,
    private readonly gateway: SocialInboxGateway,
    private readonly ai: { generator: CopyGenerator | null; credits: CreditService; generations: GenerationStore; profiles: BusinessProfileReader },
    private readonly now: () => Date = () => new Date()
  ) {}

  // ---------- الاستقبال ----------
  async handleWebhook(body: unknown) {
    const events = parseSocialWebhook(body);
    const byAccount = new Map<string, InboxEvent[]>();
    for (const e of events) {
      const k = `${e.platform}|${e.accountExternalId}`;
      byAccount.set(k, [...(byAccount.get(k) ?? []), e]);
    }
    let saved = 0;
    for (const [k, list] of byAccount) {
      const [platform, externalId] = k.split("|") as ["FACEBOOK" | "INSTAGRAM", string];
      const owner = await this.store.ownerOf(platform, externalId);
      if (!owner) {
        console.warn(`[social-webhook] event for ${platform} ${externalId} but no company has it connected`);
        continue;
      }
      await this.fillNames(owner.tenantId, owner.id, list);
      saved += await this.store.record(owner.tenantId, owner.id, list);
    }
    return { received: events.length, saved };
  }

  // "Check for new": نجيب آخر التعليقات والرسايل من Meta (لو الـ webhook فاته حاجة)
  async sync(tenantId: string) {
    const accounts = await this.store.activeAccounts(tenantId);
    let added = 0;
    const errors: string[] = [];
    for (const a of accounts) {
      try {
        const { events, warnings } = await this.gateway.fetchRecent(this.toInbox(a));
        added += await this.store.record(tenantId, a.id, events);
        for (const w of warnings) errors.push(`${a.name}: ${w}`);
      } catch (err) {
        errors.push(`${a.name}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
    return { accounts: accounts.length, added, errors };
  }

  // ---------- العرض ----------
  async threads(tenantId: string, filter: { kind?: InboxKind; accountId?: string }) {
    const now = this.now().getTime();
    const list = await this.store.threads(tenantId, filter);
    return list.map((t) => ({ ...t, canReply: t.kind === "COMMENT" || (t.lastInboundAt !== null && now - t.lastInboundAt.getTime() < DM_REPLY_WINDOW_MS) }));
  }

  async thread(tenantId: string, ref: ThreadRef) {
    const account = await this.store.account(tenantId, ref.accountId);
    if (!account) throw new NotFoundError("Conversation not found");
    const messages = await this.store.messages(tenantId, ref.accountId, ref.kind, ref.threadKey);
    if (!messages.length) throw new NotFoundError("Conversation not found");
    await this.store.markRead(tenantId, ref.accountId, ref.kind, ref.threadKey);
    return { account: { id: account.id, name: account.name, platform: account.platform }, messages, canReply: this.windowOpen(ref.kind, messages) };
  }

  unreadCount(tenantId: string) {
    return this.store.unreadCount(tenantId);
  }

  // ---------- الرد ----------
  async reply(tenantId: string, userId: string | null, ref: ThreadRef, text: string) {
    const clean = text.trim();
    if (!clean) throw new ValidationError("Write the reply first.");
    const account = await this.store.account(tenantId, ref.accountId);
    if (!account) throw new NotFoundError("Conversation not found");
    if (account.status !== "ACTIVE") throw new ValidationError("This account needs to be connected again (Publish → Connect).");
    const messages = await this.store.messages(tenantId, ref.accountId, ref.kind, ref.threadKey);
    if (!messages.length) throw new NotFoundError("Conversation not found");
    if (!this.windowOpen(ref.kind, messages)) {
      throw new AppError(422, "WINDOW_CLOSED", "Meta only allows replying to a private message within 24 hours of the customer's last message.");
    }

    const inbox = this.toInbox(account);
    let sent: { id: string };
    try {
      sent = ref.kind === "COMMENT" ? await this.gateway.replyToComment(inbox, ref.threadKey, clean) : await this.gateway.sendDirectMessage(inbox, ref.threadKey, clean);
    } catch (err) {
      if (err instanceof SocialPlatformError) throw new AppError(502, "SOCIAL_PLATFORM_ERROR", `Meta: ${err.message}`);
      throw err;
    }
    await this.store.record(
      tenantId,
      account.id,
      [
        {
          platform: account.platform === "INSTAGRAM" ? "INSTAGRAM" : "FACEBOOK",
          accountExternalId: account.externalId,
          kind: ref.kind,
          direction: "OUT",
          externalId: sent.id,
          threadKey: ref.threadKey,
          parentExternalId: ref.kind === "COMMENT" ? ref.threadKey : null,
          postExternalId: null,
          postCaption: null,
          authorId: null,
          authorName: null,
          text: clean,
          createdAt: this.now(),
        },
      ],
      userId
    );
    return this.thread(tenantId, ref);
  }

  // ---------- اقتراح رد بالذكاء الاصطناعي ----------
  get canSuggest() {
    return this.ai.generator !== null;
  }

  async suggest(tenantId: string, userId: string | null, ref: ThreadRef, dialect: CopyBrief["dialect"] = "qatari") {
    const generator = this.ai.generator;
    if (!generator) throw new ServiceUnavailableError("AI writing isn't set up yet — please contact support.");
    const account = await this.store.account(tenantId, ref.accountId);
    if (!account) throw new NotFoundError("Conversation not found");
    const messages = await this.store.messages(tenantId, ref.accountId, ref.kind, ref.threadKey);
    const lastIn = [...messages].reverse().find((m) => m.direction === "IN");
    if (!lastIn) throw new ValidationError("There's no customer message to reply to.");
    const business = await this.ai.profiles.business(tenantId);
    if (!business) throw new NotFoundError("Company not found");

    const caption = messages.find((m) => m.postCaption)?.postCaption;
    const history = messages
      .slice(-6)
      .map((m) => `${m.direction === "IN" ? "Customer" : "Business"}: ${m.text}`)
      .join("\n");
    const brief: CopyBrief = {
      kind: "reply",
      dialect,
      tone: "friendly",
      platform: account.platform === "INSTAGRAM" ? "instagram" : "facebook",
      topic: lastIn.text.slice(0, 500),
      details: [
        ref.kind === "COMMENT" ? "This is a public comment — keep the reply public-friendly and short." : "This is a private message.",
        caption ? `The post they commented on: ${caption}` : "",
        `Conversation so far:\n${history}`,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1500),
      variants: 3,
    };

    const id = randomUUID();
    const cost = AI_COSTS.copy;
    const { result, balance } = await this.ai.credits.chargeFor({ tenantId, cost, reason: "AI_COPY", userId, refId: id }, async () => {
      const out = await generator.generate(brief, business);
      await this.ai.generations.create({ id, tenantId, userId, tool: "reply", kind: "reply", input: brief, output: out, creditsUsed: cost, model: generator.model });
      return out;
    });
    return { suggestions: result.variants.map((v) => v.text), creditsUsed: cost, balance };
  }

  // الرسايل الخاصة بتوصل من غير اسم: نسأل Meta مرة لكل محادثة (لو فشل بتفضل "Customer")
  private async fillNames(tenantId: string, accountId: string, events: InboxEvent[]) {
    if (!this.gateway.lookupName) return;
    const missing = events.filter((e) => e.kind === "DM" && e.direction === "IN" && !e.authorName);
    if (!missing.length) return;
    const account = await this.store.account(tenantId, accountId);
    if (!account || account.status !== "ACTIVE") return;
    const names = new Map<string, string | null>();
    for (const e of missing) {
      if (!names.has(e.threadKey)) {
        let name = await this.store.threadName(accountId, e.threadKey);
        if (!name) name = await this.gateway.lookupName(this.toInbox(account), e.threadKey).catch(() => null);
        names.set(e.threadKey, name);
      }
      e.authorName = names.get(e.threadKey) ?? null;
    }
  }

  private windowOpen(kind: InboxKind, messages: { direction: string; createdAt: Date }[]) {
    if (kind === "COMMENT") return true;
    const lastIn = [...messages].reverse().find((m) => m.direction === "IN");
    return Boolean(lastIn && this.now().getTime() - lastIn.createdAt.getTime() < DM_REPLY_WINDOW_MS);
  }

  private toInbox(a: InboxAccountRow) {
    return { platform: a.platform, externalId: a.externalId, parentId: a.parentId, accessToken: decryptToken(a.accessToken) };
  }
}
