import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";
import { fillName, hasHours, isOpenAt, nextAssignee, weekHoursSchema, type WeekHours } from "./inbox-hours";

// أدوات Team Inbox: ردود جاهزة، توزيع المحادثات على الفريق، رسالة برّه مواعيد الشغل

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  sortOrder: number;
}
export interface InboxSettings {
  autoAssign: "off" | "round_robin";
  assignUserIds: string[];
  awayEnabled: boolean;
  awayText: string;
  hours: WeekHours | null;
  timezone: string | null;
  awayEveryHours: number;
}

export interface InboxToolsStore {
  quickReplies(tenantId: string): Promise<QuickReply[]>;
  quickReply(tenantId: string, id: string): Promise<QuickReply | null>;
  shortcutTaken(tenantId: string, shortcut: string, exceptId?: string): Promise<boolean>;
  createQuickReply(tenantId: string, data: Omit<QuickReply, "id">): Promise<QuickReply>;
  updateQuickReply(id: string, data: Partial<Omit<QuickReply, "id">>): Promise<QuickReply>;
  deleteQuickReply(id: string): Promise<void>;
  settings(tenantId: string): Promise<InboxSettings>;
  saveSettings(tenantId: string, s: InboxSettings): Promise<InboxSettings>;
  // موظفين نشطين من نفس الشركة (من القايمة دي)
  activeUserIds(tenantId: string, ids: string[]): Promise<string[]>;
  companyTimezone(tenantId: string): Promise<string | null>;
  // بيختار اللي عليه الدور ويعيّنه للمحادثة لو مالهاش حد - في transaction (رسالتين في نفس الوقت = تعيين واحد)
  assignRoundRobin(tenantId: string, phone: string, pick: (activeIds: string[], last: string | null) => string | null): Promise<string | null>;
  // true = يتبعتله رسالة "برّه المواعيد" دلوقتي (مابعتناش له من ساعات كفاية)
  claimAway(tenantId: string, phone: string, now: Date, everyHours: number): Promise<boolean>;
}

export interface InboxMessenger {
  sendText(tenantId: string, phone: string, name: string | null, text: string): Promise<boolean>;
}

const shortcut = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^\/+/, "").replace(/\s+/g, "-"))
  .pipe(z.string().regex(/^[\p{L}\p{N}_-]{1,30}$/u, "Shortcut: letters, numbers, - or _ (up to 30)"));
const quickReplySchema = z.object({
  shortcut,
  title: z.string().trim().min(1, "Give it a title").max(80),
  body: z.string().trim().min(1, "Write the reply").max(1024, "Up to 1024 characters"),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const settingsSchema = z.object({
  autoAssign: z.enum(["off", "round_robin"]).optional(),
  assignUserIds: z.array(z.string().uuid()).max(50).optional(),
  awayEnabled: z.boolean().optional(),
  awayText: z.string().max(1024, "Away message: up to 1024 characters").optional(),
  hours: weekHoursSchema.nullable().optional(),
  timezone: z.string().max(60).nullable().optional(),
  awayEveryHours: z.number().int().min(1).max(72).optional(),
});

export const MAX_QUICK_REPLIES = 200;

const firstIssue = (err: z.ZodError) => err.issues[0]?.message ?? "Invalid data";

export class InboxToolsService {
  constructor(
    private readonly store: InboxToolsStore,
    private readonly messenger: InboxMessenger,
    private readonly now: () => Date = () => new Date()
  ) {}

  listQuickReplies(tenantId: string) {
    return this.store.quickReplies(tenantId);
  }

  async createQuickReply(tenantId: string, input: unknown) {
    const p = quickReplySchema.safeParse(input);
    if (!p.success) throw new ValidationError(firstIssue(p.error));
    const all = await this.store.quickReplies(tenantId);
    if (all.length >= MAX_QUICK_REPLIES) throw new ValidationError(`Up to ${MAX_QUICK_REPLIES} quick replies.`);
    if (await this.store.shortcutTaken(tenantId, p.data.shortcut)) throw new AppError(409, "SHORTCUT_TAKEN", `/${p.data.shortcut} is already used.`);
    return this.store.createQuickReply(tenantId, { ...p.data, sortOrder: p.data.sortOrder ?? all.length });
  }

  async updateQuickReply(tenantId: string, id: string, input: unknown) {
    const row = await this.store.quickReply(tenantId, id);
    if (!row) throw new NotFoundError("Quick reply not found");
    const p = quickReplySchema.partial().safeParse(input);
    if (!p.success) throw new ValidationError(firstIssue(p.error));
    if (p.data.shortcut && p.data.shortcut !== row.shortcut && (await this.store.shortcutTaken(tenantId, p.data.shortcut, id))) {
      throw new AppError(409, "SHORTCUT_TAKEN", `/${p.data.shortcut} is already used.`);
    }
    return this.store.updateQuickReply(id, p.data);
  }

  async deleteQuickReply(tenantId: string, id: string) {
    const row = await this.store.quickReply(tenantId, id);
    if (!row) throw new NotFoundError("Quick reply not found");
    await this.store.deleteQuickReply(id);
  }

  async getSettings(tenantId: string) {
    const s = await this.store.settings(tenantId);
    return { ...s, timezone: s.timezone ?? (await this.store.companyTimezone(tenantId)) ?? "Asia/Qatar" };
  }

  async saveSettings(tenantId: string, input: unknown) {
    const p = settingsSchema.safeParse(input);
    if (!p.success) throw new ValidationError(firstIssue(p.error));
    const cur = await this.store.settings(tenantId);
    const next: InboxSettings = { ...cur };
    const d = p.data;
    if (d.autoAssign !== undefined) next.autoAssign = d.autoAssign;
    if (d.awayEnabled !== undefined) next.awayEnabled = d.awayEnabled;
    if (d.awayText !== undefined) next.awayText = d.awayText.trim();
    if (d.hours !== undefined) next.hours = d.hours as WeekHours | null;
    if (d.timezone !== undefined) next.timezone = d.timezone;
    if (d.awayEveryHours !== undefined) next.awayEveryHours = d.awayEveryHours;
    if (d.assignUserIds) {
      const uniq = [...new Set(d.assignUserIds)];
      const active = await this.store.activeUserIds(tenantId, uniq);
      if (active.length !== uniq.length) throw new ValidationError("Pick team members from your own company (active accounts only).");
      next.assignUserIds = uniq;
    }
    if (next.autoAssign === "round_robin" && !next.assignUserIds.length) throw new ValidationError("Pick at least one team member to share the chats between.");
    if (next.awayEnabled && !next.awayText) throw new ValidationError("Write the away message first.");
    if (next.awayEnabled && !hasHours(next.hours)) throw new ValidationError("Set your working hours first — the away message goes out outside them.");
    if (next.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: next.timezone });
      } catch {
        throw new ValidationError("Unknown time zone");
      }
    }
    return this.store.saveSettings(tenantId, next);
  }

  // بعد كل رسالة جاية من عميل (بعد STOP والسيناريوهات والموظف الذكي)
  // autoReplied = السيناريو أو الموظف الذكي رد بالفعل ← مفيش داعي لرسالة "برّه المواعيد"
  async afterInbound(tenantId: string, m: { phone: string; name: string | null; autoReplied: boolean }): Promise<{ assignedTo: string | null; awaySent: boolean }> {
    const s = await this.store.settings(tenantId);
    let assignedTo: string | null = null;
    if (s.autoAssign === "round_robin" && s.assignUserIds.length) {
      const order = s.assignUserIds;
      assignedTo = await this.store.assignRoundRobin(tenantId, m.phone, (active, last) => {
        const available = order.filter((id) => active.includes(id));
        return nextAssignee(available, last && available.includes(last) ? last : nearestBefore(order, available, last));
      });
    }
    let awaySent = false;
    if (s.awayEnabled && s.awayText.trim() && !m.autoReplied) {
      const tz = s.timezone ?? (await this.store.companyTimezone(tenantId)) ?? "Asia/Qatar";
      const now = this.now();
      if (!isOpenAt(s.hours, tz, now) && (await this.store.claimAway(tenantId, m.phone, now, s.awayEveryHours))) {
        awaySent = await this.messenger.sendText(tenantId, m.phone, m.name, fillName(s.awayText, m.name));
      }
    }
    return { assignedTo, awaySent };
  }
}

// لو آخر واحد اتعيّن بقى مش متاح (اتوقف حسابه) نكمّل من اللي قبله في الترتيب الأصلي
function nearestBefore(order: string[], available: string[], last: string | null): string | null {
  if (!last) return null;
  const i = order.indexOf(last);
  if (i < 0) return null;
  for (let k = 1; k <= order.length; k++) {
    const id = order[(i - k + order.length) % order.length];
    if (available.includes(id)) return id;
  }
  return null;
}
