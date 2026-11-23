import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { isManageSession, refreshTokenKey } from "../../utils/jwt";
import { createPasswordLink, emailTaken, sendEmailChangedNotice, sendOwnerInviteEmail } from "../auth/account-links";

// حسابي: أي يوزر يغيّر إيميل الدخول أو الباسورد بتاعه، وصاحب الشركة (OWNER)
// يقدر ينقل الملكية لإيميل حد تاني. كل حاجة حساسة محتاجة الباسورد الحالي
// (لو الحساب بجوجل ومالوش باسورد، الجلسة نفسها كفاية)
export const accountRouter = Router();
accountRouter.use(requireAuth);

// بيانات الدخول (إيميل/باسورد/نقل ملكية) بيغيّرها صاحب الحساب بس - مش حد داخل "إدارة نيابةً"
// (قبل كده جلسة إدارة على مالك داخل بجوجل كانت تقدر تحط باسورد وتاخد الحساب)
accountRouter.use((req, res, next) => {
  if (req.method !== "GET" && isManageSession(req.auth!)) {
    return res.status(403).json({ error: "Only the account holder can change sign-in details" });
  }
  next();
});

async function me(req: { auth?: { userId: string; tenantId: string } }) {
  return prisma.user.findFirst({ where: { id: req.auth!.userId, tenantId: req.auth!.tenantId } });
}

// بعد تغيير الباسورد/الإيميل: كل الأجهزة التانية بتخرج (تدقيق أمني AUTH-10).
// الجهاز الحالي بيبعت الـ refresh token بتاعه في keepRefreshToken فبيفضل داخل
async function signOutOtherDevices(userId: string, keep: unknown) {
  const keepKey = typeof keep === "string" && keep ? refreshTokenKey(keep) : null;
  await prisma.refreshToken.deleteMany({ where: { userId, ...(keepKey ? { token: { not: keepKey } } : {}) } });
}

async function passwordOk(user: { passwordHash: string | null }, password: string | undefined) {
  if (!user.passwordHash) return true;
  return Boolean(password) && (await bcrypt.compare(password!, user.passwordHash));
}

accountRouter.get("/", async (req, res) => {
  const user = await me(req);
  if (!user) return res.status(404).json({ error: "User not found" });
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } });
  res.json({ name: user.name, email: user.email, role: user.role, hasPassword: Boolean(user.passwordHash), usesGoogle: Boolean(user.googleId), companyName: tenant?.name ?? "" });
});

const emailSchema = z.object({ newEmail: z.string().trim().toLowerCase().email("Enter a valid email"), currentPassword: z.string().optional() });

accountRouter.patch("/email", async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid email" });
  const user = await me(req);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!(await passwordOk(user, parsed.data.currentPassword))) return res.status(400).json({ error: "Your current password is wrong" });
  const newEmail = parsed.data.newEmail;
  if (newEmail === user.email.toLowerCase()) return res.status(400).json({ error: "That's already your email" });
  if (await emailTaken(newEmail, user.id)) return res.status(400).json({ error: "This email is already used by another account" });
  const old = user.email;
  // الإيميل الجديد مش مربوط بجوجل القديم
  await prisma.user.update({ where: { id: user.id }, data: { email: newEmail, googleId: null } });
  await signOutOtherDevices(user.id, req.body?.keepRefreshToken);
  await sendEmailChangedNotice(old, user.name, newEmail).catch(() => {});
  res.json({ ok: true, email: newEmail });
});

const passwordSchema = z.object({ currentPassword: z.string().optional(), newPassword: z.string().min(8, "The new password must be at least 8 characters").max(200) });

accountRouter.post("/password", async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid password" });
  const user = await me(req);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!(await passwordOk(user, parsed.data.currentPassword))) return res.status(400).json({ error: "Your current password is wrong" });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10) } });
  await signOutOtherDevices(user.id, req.body?.keepRefreshToken);
  res.json({ ok: true });
});

const transferSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter the new owner's email"),
  name: z.string().trim().min(2).max(80).optional(),
  currentPassword: z.string().optional(),
});

// نقل الملكية: لو الإيميل ده موظف في نفس الشركة بيبقى هو الـ OWNER، غير كده
// بيتعمل له حساب جديد OWNER ويوصله لينك يختار فيه الباسورد. الصاحب القديم بيبقى ADMIN
accountRouter.post("/transfer-ownership", requireRole("OWNER"), async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
  const user = await me(req);
  if (!user) return res.status(404).json({ error: "User not found" });
  // الدور من قاعدة البيانات مش من التوكن (التوكن بيفضل OWNER 15 دقيقة بعد النقل)
  if (user.role !== "OWNER" || !user.isActive) return res.status(403).json({ error: "Only the company owner can do this" });
  if (!(await passwordOk(user, parsed.data.currentPassword))) return res.status(400).json({ error: "Your current password is wrong" });
  const result = await transferOwnership(user.tenantId, user.id, parsed.data.email, parsed.data.name);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

class OwnershipChangedError extends Error {}

// بتتنده من حسابي ومن السوبر أدمن
export async function transferOwnership(tenantId: string, currentOwnerId: string | null, emailRaw: string, name?: string) {
  const email = emailRaw.trim().toLowerCase();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  if (!tenant) return { ok: false as const, error: "Company not found" };
  const inCompany = await prisma.user.findFirst({ where: { tenantId, email: { equals: email, mode: "insensitive" } } });
  if (inCompany && inCompany.id === currentOwnerId) return { ok: false as const, error: "You are already the owner" };
  if (!inCompany && (await emailTaken(email))) return { ok: false as const, error: "This email already has a BlueField account in another company — use a different email" };

  let newOwner: { id: string; email: string; name: string; passwordHash: string | null };
  try {
  newOwner = await prisma.$transaction(async (tx: any) => {
    // claim ذري: النقل بيعدّي بس لو الشخص لسه OWNER وقت الكتابة (قبل كده نقلين ورا بعض
    // بنفس التوكن القديم كانوا بيطلّعوا شركة فيها مالكين)
    if (currentOwnerId) {
      const demoted = await tx.user.updateMany({ where: { id: currentOwnerId, tenantId, role: "OWNER" }, data: { role: "ADMIN" } });
      if (demoted.count === 0) throw new OwnershipChangedError();
    }
    if (inCompany) return tx.user.update({ where: { id: inCompany.id }, data: { role: "OWNER", isActive: true } });
    return tx.user.create({ data: { tenantId, email, name: name || email.split("@")[0], role: "OWNER" } });
  });
  } catch (err) {
    if (err instanceof OwnershipChangedError) return { ok: false as const, error: "Ownership was already transferred — sign in again" };
    throw err;
  }
  // حساب جديد (أو من غير باسورد) -> لينك يختار فيه الباسورد
  const link = newOwner.passwordHash ? null : await createPasswordLink(newOwner.id, "INVITE");
  const sent = await sendOwnerInviteEmail({ to: newOwner.email, name: newOwner.name, companyName: tenant.name, setPasswordLink: link });
  return { ok: true as const, ownerEmail: newOwner.email, emailSent: sent.ok, newAccount: !inCompany };
}
