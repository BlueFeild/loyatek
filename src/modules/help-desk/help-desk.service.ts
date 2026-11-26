import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";

// صندوق "محتاج مساعدة؟": التاجر يبعت سؤال/مشكلة لفريق المنصة، والسوبر أدمن يرد.
// الخدمة دي فيها القواعد بس (مين يشوف إيه، الحالة بتتغير إزاي، الحد) - من غير Prisma ولا إيميل مباشرة

export const HELP_CATEGORIES = ["question", "problem", "billing", "idea"] as const;
export const HELP_STATUSES = ["OPEN", "ANSWERED", "CLOSED"] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];
export type HelpStatus = (typeof HELP_STATUSES)[number];

export interface HelpTicketRow {
  id: string;
  tenantId: string;
  userId: string;
  subject: string;
  message: string;
  category: string;
  status: string;
  pageUrl: string | null;
  lastActivityAt: Date;
  lastFromSuperAdmin: boolean;
  createdAt: Date;
}
export interface HelpReplyRow {
  id: string;
  ticketId: string;
  fromSuperAdmin: boolean;
  authorUserId: string;
  message: string;
  createdAt: Date;
}
export interface PersonInfo {
  id: string;
  name: string;
  email: string;
}

export interface HelpStore {
  countCreatedSince(tenantId: string, since: Date): Promise<number>;
  create(d: { tenantId: string; userId: string; subject: string; message: string; category: HelpCategory; pageUrl: string | null }): Promise<HelpTicketRow>;
  // tenantId = null → السوبر أدمن (أي شركة)
  find(id: string, tenantId: string | null): Promise<HelpTicketRow | null>;
  listForTenant(tenantId: string): Promise<(HelpTicketRow & { replyCount: number })[]>;
  listAll(status: HelpStatus | null): Promise<(HelpTicketRow & { replyCount: number })[]>;
  countByStatus(): Promise<Record<HelpStatus, number>>;
  replies(ticketId: string): Promise<HelpReplyRow[]>;
  // يضيف الرد ويغيّر الحالة وآخر نشاط مع بعض (transaction)
  addReply(ticketId: string, d: { fromSuperAdmin: boolean; authorUserId: string; message: string; status: HelpStatus }): Promise<HelpReplyRow>;
  setStatus(ticketId: string, status: HelpStatus): Promise<void>;
  people(ids: string[]): Promise<PersonInfo[]>;
  companies(ids: string[]): Promise<{ id: string; name: string; slug: string | null }[]>;
}

export interface HelpMailer {
  // للفريق (SUPPORT_EMAIL) - replyTo = إيميل التاجر
  toSupport(subject: string, text: string, replyTo?: string): Promise<unknown>;
  toMerchant(email: string, subject: string, text: string): Promise<unknown>;
  // إشعار جوه اللوحة (الجرس)
  notifyTenant(tenantId: string, title: string, body: string, link: string): Promise<unknown>;
}

export interface HelpLinks {
  adminTicket(id: string): string;
  merchantTicket(id: string): string;
}

const clean = (s: string) => s.replace(/\r\n/g, "\n").trim();
export const createTicketSchema = z
  .object({
    category: z.enum(HELP_CATEGORIES),
    subject: z.string().transform(clean).pipe(z.string().min(1, "Please write a short title.").max(120, "The title is too long (120 letters max).")),
    message: z.string().transform(clean).pipe(z.string().min(1, "Please write your message.").max(4000, "The message is too long (4000 letters max).")),
    pageUrl: z.string().max(300).optional().nullable(),
  })
  .strict();
export const replySchema = z
  .object({ message: z.string().transform(clean).pipe(z.string().min(1, "Please write your reply.").max(4000, "The message is too long (4000 letters max).")) })
  .strict();
export const statusSchema = z.object({ status: z.enum(HELP_STATUSES) }).strict();

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ValidationError(issue?.code === "unrecognized_keys" ? "Some fields aren't allowed here." : issue?.message || "Please check the form and try again.");
}

// رابط الصفحة: مسار داخل اللوحة بس (من غير دومين ولا query فيها توكن) - للسياق مش أكتر
export function cleanPageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let path = raw.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname + new URL(path).search;
  } catch {
    return null;
  }
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  path = path.replace(/([?&])(token|code|state|access_token|refresh_token)=[^&]*/gi, "$1$2=…");
  return path.slice(0, 300);
}

export interface Actor {
  tenantId: string;
  userId: string;
}

export const CATEGORY_LABEL: Record<HelpCategory, string> = { question: "Question", problem: "Problem", billing: "Billing", idea: "Idea" };
const TEAM_NAME = "BlueField team";

export class HelpDeskService {
  constructor(
    private readonly store: HelpStore,
    private readonly mailer: HelpMailer,
    private readonly links: HelpLinks,
    private readonly opts: { maxTicketsPerHour: number; now?: () => Date } = { maxTicketsPerHour: 10 }
  ) {}

  private now() {
    return this.opts.now ? this.opts.now() : new Date();
  }

  // ===== التاجر =====
  async create(actor: Actor, input: unknown) {
    const d = parse(createTicketSchema, input);
    const since = new Date(this.now().getTime() - 60 * 60_000);
    if ((await this.store.countCreatedSince(actor.tenantId, since)) >= this.opts.maxTicketsPerHour) {
      throw new AppError(429, "TOO_MANY_TICKETS", "You sent many messages in the last hour. Please wait a little, or reply inside one of your messages.");
    }
    const ticket = await this.store.create({ tenantId: actor.tenantId, userId: actor.userId, subject: d.subject, message: d.message, category: d.category, pageUrl: cleanPageUrl(d.pageUrl) });
    await this.emailSupport(ticket, d.message, "new");
    return this.view(ticket, [], false);
  }

  async listMine(actor: Actor) {
    const rows = await this.store.listForTenant(actor.tenantId);
    return rows.map((t) => ({ ...this.summary(t), replyCount: t.replyCount }));
  }

  async getMine(actor: Actor, id: string) {
    const ticket = await this.store.find(id, actor.tenantId);
    if (!ticket) throw new NotFoundError("Message not found");
    return this.view(ticket, await this.store.replies(ticket.id), false);
  }

  async replyAsMerchant(actor: Actor, id: string, input: unknown) {
    const { message } = parse(replySchema, input);
    const ticket = await this.store.find(id, actor.tenantId);
    if (!ticket) throw new NotFoundError("Message not found");
    // رد من التاجر = محتاج فريقنا تاني (حتى لو كانت مقفولة)
    await this.store.addReply(ticket.id, { fromSuperAdmin: false, authorUserId: actor.userId, message, status: "OPEN" });
    await this.emailSupport({ ...ticket, status: "OPEN" }, message, "reply");
    return this.getMine(actor, id);
  }

  // ===== السوبر أدمن =====
  async adminList(statusRaw: unknown) {
    const status = typeof statusRaw === "string" && (HELP_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as HelpStatus) : null;
    const [rows, counts] = await Promise.all([this.store.listAll(status), this.store.countByStatus()]);
    const [people, companies] = await Promise.all([this.store.people([...new Set(rows.map((r) => r.userId))]), this.store.companies([...new Set(rows.map((r) => r.tenantId))])]);
    const pm = new Map(people.map((p) => [p.id, p]));
    const cm = new Map(companies.map((c) => [c.id, c]));
    return {
      counts,
      tickets: rows.map((t) => ({
        ...this.summary(t),
        replyCount: t.replyCount,
        company: cm.get(t.tenantId) ?? { id: t.tenantId, name: "—", slug: null },
        user: pm.get(t.userId) ?? null,
      })),
    };
  }

  async adminGet(id: string) {
    const ticket = await this.store.find(id, null);
    if (!ticket) throw new NotFoundError("Message not found");
    const [company] = await this.store.companies([ticket.tenantId]);
    const [user] = await this.store.people([ticket.userId]);
    return { ...(await this.view(ticket, await this.store.replies(ticket.id), true)), company: company ?? null, user: user ?? null };
  }

  async replyAsAdmin(adminUserId: string, id: string, input: unknown) {
    const { message } = parse(replySchema, input);
    const ticket = await this.store.find(id, null);
    if (!ticket) throw new NotFoundError("Message not found");
    await this.store.addReply(ticket.id, { fromSuperAdmin: true, authorUserId: adminUserId, message, status: "ANSWERED" });
    const [user] = await this.store.people([ticket.userId]);
    const link = this.links.merchantTicket(ticket.id);
    const text = [`Hi ${user?.name || "there"},`, "", `The BlueField team replied to your message "${ticket.subject}":`, "", message, "", `Open it in your dashboard: ${link}`, "", "You can reply there too."].join("\n");
    await Promise.allSettled([
      user?.email ? this.mailer.toMerchant(user.email, `Re: ${ticket.subject}`, text) : Promise.resolve(),
      this.mailer.notifyTenant(ticket.tenantId, "The BlueField team replied", `"${ticket.subject}"`, `/dashboard?help=${ticket.id}`),
    ]);
    return this.adminGet(id);
  }

  async adminSetStatus(id: string, input: unknown) {
    const { status } = parse(statusSchema, input);
    const ticket = await this.store.find(id, null);
    if (!ticket) throw new NotFoundError("Message not found");
    if (ticket.status !== status) await this.store.setStatus(ticket.id, status);
    return this.adminGet(id);
  }

  // ===== مساعدات =====
  private summary(t: HelpTicketRow) {
    return {
      id: t.id,
      subject: t.subject,
      category: t.category,
      status: t.status,
      pageUrl: t.pageUrl,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      lastFromSuperAdmin: t.lastFromSuperAdmin,
    };
  }

  private async view(t: HelpTicketRow, replies: HelpReplyRow[], forAdmin: boolean) {
    const people = await this.store.people([...new Set(replies.filter((r) => !r.fromSuperAdmin || forAdmin).map((r) => r.authorUserId))]);
    const names = new Map(people.map((p) => [p.id, p.name]));
    return {
      ...this.summary(t),
      message: t.message,
      replies: replies.map((r) => ({
        id: r.id,
        fromSuperAdmin: r.fromSuperAdmin,
        // التاجر يشوف "فريق BlueField" بس، من غير اسم الموظف عندنا
        author: r.fromSuperAdmin ? (forAdmin ? `${TEAM_NAME} · ${names.get(r.authorUserId) ?? ""}`.replace(/ · $/, "") : TEAM_NAME) : names.get(r.authorUserId) ?? "",
        message: r.message,
        createdAt: r.createdAt,
      })),
    };
  }

  private async emailSupport(t: HelpTicketRow, message: string, kind: "new" | "reply") {
    const [[company], [user]] = await Promise.all([this.store.companies([t.tenantId]), this.store.people([t.userId])]);
    const label = CATEGORY_LABEL[t.category as HelpCategory] ?? t.category;
    const subject = `${kind === "new" ? "[Support]" : "[Support reply]"} ${label}: ${t.subject} — ${company?.name ?? "company"}`;
    const text = [
      kind === "new" ? "A merchant sent a new support message." : "The merchant replied to a support message.",
      "",
      `Company: ${company?.name ?? "—"}${company?.slug ? ` (${company.slug})` : ""}`,
      `From: ${user?.name ?? "—"} <${user?.email ?? "—"}>`,
      `Type: ${label}`,
      `Title: ${t.subject}`,
      t.pageUrl ? `Page: ${t.pageUrl}` : null,
      "",
      message,
      "",
      `Answer it here: ${this.links.adminTicket(t.id)}`,
    ]
      .filter((l) => l !== null)
      .join("\n");
    await this.mailer.toSupport(subject, text, user?.email).catch(() => undefined);
  }
}
