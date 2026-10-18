import { Router } from "express";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
import bcrypt from "bcryptjs";
import { prisma } from "../../config/db";
import { createPasswordLink, hashToken, sendResetEmail } from "./account-links";
import { registerTenant, login, refreshAccessToken, loginWithGoogle, registerTenantWithGoogle } from "./auth.service";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const authRouter = Router();

const registerSchema = z.object({
  companyName: z.string().min(2),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
  ownerName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await registerTenant(parsed.data);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await login(parsed.data);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: "refreshToken is required" });

  try {
    const result = await refreshAccessToken(refreshToken);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// التحقق الحقيقي من توكن جوجل - بيتأكد من Google نفسها إن التوكن
// حقيقي وماتزوّرش، مش بس بياخد الإيميل من الفرونت إند على الآخر
async function verifyGoogleToken(idToken: string) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google Sign-In isn't configured on the server yet (missing GOOGLE_CLIENT_ID).");
  }
  const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.sub) throw new Error("Invalid Google token");
  return { googleId: payload.sub, email: payload.email, name: payload.name ?? payload.email };
}

const googleLoginSchema = z.object({ idToken: z.string().min(1) });

authRouter.post("/google/login", async (req, res) => {
  const parsed = googleLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { googleId, email, name } = await verifyGoogleToken(parsed.data.idToken);
    const result = await loginWithGoogle(googleId, email, name);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

const googleSignupSchema = z.object({
  idToken: z.string().min(1),
  companyName: z.string().min(2),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
});

authRouter.post("/google/signup", async (req, res) => {
  const parsed = googleSignupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { googleId, email, name } = await verifyGoogleToken(parsed.data.idToken);
    const result = await registerTenantWithGoogle({ companyName: parsed.data.companyName, industry: parsed.data.industry, googleId, email, name });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- نسيت الباسورد ---

const forgotSchema = z.object({ email: z.string().trim().email() });

// دايمًا نفس الرد (حتى لو الإيميل مش موجود) عشان محدش يعرف مين عنده حساب.
// بحد أقصى ٣ لينكات في الساعة للحساب الواحد
authRouter.post("/forgot-password", async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email" });
  const reply = { ok: true, message: "If this email has an account, we've sent a link to reset the password. Check your inbox (and spam)." };
  const user = await prisma.user.findFirst({ where: { email: { equals: parsed.data.email, mode: "insensitive" }, isActive: true, isLinkedCompany: false } });
  if (!user) return res.json(reply);
  const recent = await prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } } });
  if (recent >= 3) return res.json(reply);
  const link = await createPasswordLink(user.id, "RESET");
  const sent = await sendResetEmail(user.email, user.name, link);
  if (!sent.ok) console.warn(`[auth] reset email not sent for user ${user.id}: ${sent.error ?? "email not configured"}`);
  res.json(reply);
});

const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(8, "The password must be at least 8 characters").max(200) });

// اللينك اللي في الإيميل -> باسورد جديد. بيقفل كل الجلسات القديمة
authRouter.post("/reset-password", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(parsed.data.token) }, include: { user: true } });
  if (!row || row.usedAt || row.expiresAt < new Date() || !row.user.isActive) {
    return res.status(400).json({ error: "This link has expired or was already used. Ask for a new one from “Forgot password”." });
  }
  // نقفل التوكن الأول (مرة واحدة بس حتى لو اتبعت مرتين في نفس اللحظة)
  const claimed = await prisma.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count === 0) return res.status(400).json({ error: "This link was already used." });
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.refreshToken.deleteMany({ where: { userId: row.userId } }),
    // أي لينكات تانية لسه شغالة للحساب ده تتقفل
    prisma.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  res.json({ ok: true, email: row.user.email });
});
