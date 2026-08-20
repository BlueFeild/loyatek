import bcrypt from "bcryptjs";
import { prisma } from "../../config/db";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../utils/jwt";
import { generateUniqueSlug } from "../../utils/slug";

interface RegisterInput {
  companyName: string;
  industry: "RETAIL" | "SERVICES" | "HOSPITALITY" | "REAL_ESTATE" | "SALONS";
  ownerName: string;
  email: string;
  password: string;
}

// عند تسجيل عميل جديد: بيتعمل Tenant (شركة) + أول مستخدم بدور OWNER
export async function registerTenant(input: RegisterInput) {
  const existing = await prisma.user.findFirst({ where: { email: input.email } });
  if (existing) throw new Error("Email already in use");

  const passwordHash = await bcrypt.hash(input.password, 10);
  const slug = await generateUniqueSlug(input.companyName);

  const tenant = await prisma.tenant.create({
    data: {
      name: input.companyName,
      industry: input.industry,
      slug,
      users: {
        create: {
          name: input.ownerName,
          email: input.email,
          passwordHash,
          role: "OWNER",
        },
      },
    },
    include: { users: true },
  });

  const owner = tenant.users[0];
  return issueTokens(owner.id, tenant.id, owner.role, null, owner.isSuperAdmin);
}

interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findFirst({ where: { email: input.email, isActive: true } });
  if (!user) throw new Error("Invalid credentials");

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw new Error("Invalid credentials");

  return issueTokens(user.id, user.tenantId, user.role, user.branchId, user.isSuperAdmin);
}

export async function refreshAccessToken(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
  if (!stored || stored.expiresAt < new Date()) {
    throw new Error("Refresh token invalid or expired");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) throw new Error("User not found");

  const accessToken = signAccessToken({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    branchId: user.branchId,
    isSuperAdmin: user.isSuperAdmin,
  });

  return { accessToken };
}

async function issueTokens(userId: string, tenantId: string, role: string, branchId: string | null, isSuperAdmin: boolean) {
  const accessToken = signAccessToken({ userId, tenantId, role, branchId, isSuperAdmin });
  const refreshToken = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      userId,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 يوم
    },
  });

  return { accessToken, refreshToken, tenantId, role, isSuperAdmin };
}
