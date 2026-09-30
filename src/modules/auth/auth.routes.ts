import { Router } from "express";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";
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
