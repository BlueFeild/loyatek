import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import type { TeamMailer, TeamMember, TeamRole, TeamStore } from "./team.service";
import { createPasswordLink, emailTaken, loginUrl, sendResetEmail } from "../auth/account-links";
import { sendEmail } from "../../utils/email";

const select = { id: true, name: true, email: true, role: true, branchId: true, isActive: true, createdAt: true, passwordHash: true, googleId: true } as const;
type Row = { id: string; name: string; email: string; role: TeamRole; branchId: string | null; isActive: boolean; createdAt: Date; passwordHash: string | null; googleId: string | null };
const toMember = ({ passwordHash, googleId, ...u }: Row): TeamMember => ({ ...u, hasPassword: Boolean(passwordHash), googleLinked: Boolean(googleId) });
const ROLE_ORDER: Record<string, number> = { OWNER: 0, ADMIN: 1, MANAGER: 2, STAFF: 3 };

export class PrismaTeamRepository implements TeamStore {
  constructor(private readonly db: PrismaClient) {}

  async members(tenantId: string) {
    // الحسابات المربوطة (نفس الشخص بشركة تانية) بتظهر برضه - هما أعضاء في الشركة دي
    const rows = await this.db.user.findMany({ where: { tenantId }, select, orderBy: { createdAt: "asc" } });
    return rows.map(toMember).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  }
  async member(tenantId: string, id: string) {
    const row = await this.db.user.findFirst({ where: { id, tenantId }, select });
    return row ? toMember(row) : null;
  }
  emailTaken(email: string, exceptId?: string) {
    return emailTaken(email, exceptId);
  }
  async branchBelongs(tenantId: string, branchId: string) {
    return (await this.db.branch.count({ where: { id: branchId, tenantId } })) > 0;
  }
  async create(tenantId: string, d: { name: string; email: string; role: TeamRole; branchId: string | null; password: string | null }) {
    const row = await this.db.user.create({
      data: { tenantId, name: d.name, email: d.email, role: d.role, branchId: d.branchId, passwordHash: d.password ? await bcrypt.hash(d.password, 10) : null },
      select,
    });
    return toMember(row);
  }
  async update(id: string, data: Partial<Pick<TeamMember, "name" | "role" | "branchId" | "isActive">>) {
    return toMember(await this.db.user.update({ where: { id }, data, select }));
  }
  async signOutEverywhere(userId: string) {
    await this.db.refreshToken.deleteMany({ where: { userId } });
  }
  async companyName(tenantId: string) {
    return (await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? "your company";
  }
}

export class EmailTeamMailer implements TeamMailer {
  async sendInvite(member: TeamMember, companyName: string, invitedBy: string | null) {
    const link = await createPasswordLink(member.id, "INVITE");
    return sendEmail(
      member.email,
      `You're invited to ${companyName} on BlueField`,
      `Hello ${member.name},

${invitedBy ? `${invitedBy} added you` : "You were added"} to the ${companyName} team on BlueField.

Choose your password using this link (valid for 7 days):
${link}

Then log in here: ${loginUrl()}

If you didn't expect this email, you can ignore it.

— BlueField`
    );
  }
  async sendPasswordLink(member: TeamMember) {
    return sendResetEmail(member.email, member.name, await createPasswordLink(member.id, "RESET"));
  }
}
