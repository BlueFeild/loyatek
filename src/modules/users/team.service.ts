import { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../../core/errors";

// صفحة الفريق: إضافة موظف (بدعوة على الإيميل أو باسورد)، تغيير الدور، إيقاف/تشغيل، لينك باسورد جديد

export type TeamRole = "OWNER" | "ADMIN" | "MANAGER" | "STAFF";
export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  branchId: string | null;
  isActive: boolean;
  createdAt: Date;
  hasPassword: boolean;
  googleLinked: boolean;
}
export interface Actor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface TeamStore {
  members(tenantId: string): Promise<TeamMember[]>;
  member(tenantId: string, id: string): Promise<TeamMember | null>;
  emailTaken(email: string, exceptId?: string): Promise<boolean>;
  branchBelongs(tenantId: string, branchId: string): Promise<boolean>;
  create(tenantId: string, data: { name: string; email: string; role: TeamRole; branchId: string | null; password: string | null }): Promise<TeamMember>;
  update(id: string, data: Partial<Pick<TeamMember, "name" | "role" | "branchId" | "isActive">>): Promise<TeamMember>;
  // إيقاف الحساب ← يخرج من كل الأجهزة
  signOutEverywhere(userId: string): Promise<void>;
  companyName(tenantId: string): Promise<string>;
}

export interface TeamMailer {
  // لينك يختار بيه باسورد (دعوة ٧ أيام)
  sendInvite(member: TeamMember, companyName: string, invitedBy: string | null): Promise<{ ok: boolean; skipped?: boolean }>;
  sendPasswordLink(member: TeamMember): Promise<{ ok: boolean; skipped?: boolean }>;
}

const role = z.enum(["ADMIN", "MANAGER", "STAFF"]);
const addSchema = z.object({
  name: z.string().trim().min(2, "Write the person's name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  role,
  branchId: z.string().uuid().nullable().optional(),
  // فاضي = نبعتله دعوة على الإيميل يختار فيها الباسورد بنفسه
  password: z.string().min(8, "Password: at least 8 characters").max(100).optional().or(z.literal("")),
});
const editSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  role: role.optional(),
  branchId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const MAX_TEAM = 100;

export class TeamService {
  constructor(
    private readonly store: TeamStore,
    private readonly mailer: TeamMailer
  ) {}

  list(tenantId: string) {
    return this.store.members(tenantId);
  }

  async add(actor: Actor, input: unknown) {
    const p = addSchema.safeParse(input);
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? "Invalid data");
    const d = p.data;
    this.assertCanGive(actor, d.role);
    if ((await this.store.members(actor.tenantId)).length >= MAX_TEAM) throw new ValidationError(`Up to ${MAX_TEAM} team members.`);
    if (d.branchId && !(await this.store.branchBelongs(actor.tenantId, d.branchId))) throw new ValidationError("Branch not found");
    if (await this.store.emailTaken(d.email)) throw new AppError(409, "EMAIL_TAKEN", "This email already has a BlueField account.");
    const member = await this.store.create(actor.tenantId, { name: d.name, email: d.email, role: d.role, branchId: d.branchId ?? null, password: d.password || null });
    let emailed: { ok: boolean; skipped?: boolean } | null = null;
    if (!d.password) {
      const inviter = (await this.store.member(actor.tenantId, actor.userId))?.name ?? null;
      emailed = await this.mailer.sendInvite(member, await this.store.companyName(actor.tenantId), inviter);
    }
    return { member, invited: !d.password, emailSent: emailed ? emailed.ok && !emailed.skipped : null };
  }

  async edit(actor: Actor, id: string, input: unknown) {
    const p = editSchema.safeParse(input);
    if (!p.success) throw new ValidationError(p.error.issues[0]?.message ?? "Invalid data");
    const target = await this.target(actor, id);
    const d = p.data;
    if (id === actor.userId && (d.role !== undefined || d.isActive === false)) throw new ValidationError("You can't change your own role or switch off your own account.");
    if (d.role) this.assertCanGive(actor, d.role);
    if (d.branchId && !(await this.store.branchBelongs(actor.tenantId, d.branchId))) throw new ValidationError("Branch not found");
    const updated = await this.store.update(target.id, d);
    if (d.isActive === false || (d.role && d.role !== target.role)) await this.store.signOutEverywhere(target.id);
    return updated;
  }

  async sendPasswordLink(actor: Actor, id: string) {
    const target = await this.target(actor, id);
    if (!target.isActive) throw new ValidationError("Switch the account on first.");
    const r = await this.mailer.sendPasswordLink(target);
    return { emailSent: r.ok && !r.skipped };
  }

  // صاحب الشركة مايتعدّلش من هنا (نقل الملكية من صفحة "حسابي")؛ الأدمن يدير المديرين والموظفين بس
  private async target(actor: Actor, id: string) {
    const target = await this.store.member(actor.tenantId, id);
    if (!target) throw new NotFoundError("Team member not found");
    if (target.role === "OWNER") throw new AppError(403, "OWNER_LOCKED", "The owner's account can only be changed from My account → Transfer ownership.");
    if (actor.role === "ADMIN" && target.role === "ADMIN" && target.id !== actor.userId) throw new AppError(403, "FORBIDDEN", "Only the owner can change another admin.");
    return target;
  }

  private assertCanGive(actor: Actor, r: TeamRole) {
    if (r === "ADMIN" && actor.role !== "OWNER") throw new AppError(403, "FORBIDDEN", "Only the owner can add or make admins.");
  }
}
