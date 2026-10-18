import crypto from "crypto";
import { prisma } from "../../config/db";
import { sendEmail } from "../../utils/email";

// لينكات الباسورد اللي بتتبعت على الإيميل: "نسيت الباسورد" (ساعة)، وحساب جديد
// اتعمل للعميل أو صاحب جديد للشركة (INVITE - ٧ أيام). التوكن عشوائي، وبنخزن
// الـ hash بتاعه بس، وبيتستخدم مرة واحدة
export type LinkPurpose = "RESET" | "INVITE";
const TTL: Record<LinkPurpose, number> = { RESET: 60 * 60 * 1000, INVITE: 7 * 24 * 60 * 60 * 1000 };

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function frontendBase() {
  return (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");
}

export async function createPasswordLink(userId: string, purpose: LinkPurpose): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({ data: { userId, tokenHash: hashToken(token), purpose, expiresAt: new Date(Date.now() + TTL[purpose]) } });
  return `${frontendBase()}/reset-password?token=${token}`;
}

export const loginUrl = () => `${frontendBase()}/login`;

// باسورد مؤقت سهل يتكتب (من غير حروف شبه بعض زي 0/O و 1/l)
export function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// إيميل ترحيب لحساب السوبر أدمن عمله للعميل: لينك الدخول + الإيميل + الباسورد
// المؤقت + لينك يختار فيه باسورد بنفسه
export async function sendWelcomeEmail(input: { to: string; name: string; companyName: string; tempPassword: string; setPasswordLink: string }) {
  return sendEmail(
    input.to,
    `Your BlueField account for ${input.companyName} is ready`,
    `Hello ${input.name},

Your BlueField account for ${input.companyName} has been created.

Log in here: ${loginUrl()}
Email: ${input.to}
Temporary password: ${input.tempPassword}

For your security, please choose your own password using this link (valid for 7 days):
${input.setPasswordLink}

If you didn't expect this email, you can ignore it.

— BlueField`
  );
}

// إيميل لصاحب جديد للشركة (اتنقلت له الملكية، أو السوبر أدمن غيّر إيميل الصاحب)
export async function sendOwnerInviteEmail(input: { to: string; name: string; companyName: string; setPasswordLink: string | null }) {
  return sendEmail(
    input.to,
    `You are now the owner of ${input.companyName} on BlueField`,
    `Hello ${input.name},

You are now the owner of ${input.companyName} on BlueField.

${input.setPasswordLink ? `Choose your password using this link (valid for 7 days):\n${input.setPasswordLink}\n\nThen log in here: ${loginUrl()}` : `Log in here with your existing password: ${loginUrl()}`}

If you didn't expect this email, please contact us.

— BlueField`
  );
}

export async function sendResetEmail(to: string, name: string, link: string) {
  return sendEmail(
    to,
    "Reset your BlueField password",
    `Hello ${name},

We received a request to reset your BlueField password. Choose a new password using this link (valid for 1 hour):
${link}

If you didn't ask for this, you can ignore this email — your password stays the same.

— BlueField`
  );
}

// إشعار للإيميل القديم إن إيميل الدخول اتغيّر (عشان لو حد تاني غيّره يعرف)
export async function sendEmailChangedNotice(oldEmail: string, name: string, newEmail: string) {
  return sendEmail(
    oldEmail,
    "Your BlueField login email was changed",
    `Hello ${name},

The login email of your BlueField account was changed to ${newEmail}.

If you didn't do this, contact us right away.

— BlueField`
  );
}

// الإيميل ده مستخدم في حساب تاني؟ (الدخول بالإيميل لازم يوصل لحساب واحد)
export async function emailTaken(email: string, exceptUserId?: string) {
  const u = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" }, isLinkedCompany: false, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { id: true },
  });
  return Boolean(u);
}
