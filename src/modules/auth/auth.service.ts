import bcrypt from "bcryptjs";
import { prisma } from "../../config/db";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../utils/jwt";
import { generateUniqueSlug } from "../../utils/slug";
import { trackPlatformEvent } from "../analytics/analytics.service";

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
  // كل شركة جديدة بتاخد تجربة مجانية 24 ساعة لكل الخدمات - الاشتراك
  // الحقيقي (subscribedModules) بيفضل فاضي لحد ما السوبر أدمن يفعّله
  const trialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const tenant = await prisma.tenant.create({
    data: {
      name: input.companyName,
      industry: input.industry,
      slug,
      trialExpiresAt,
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

  // كل شركة محتاجة فرع افتراضي واحد على الأقل عشان باقي النظام يشتغل
  // (الحجوزات، المخزون، الكتالوج...) - من غيره كل حاجة بتفشل بصمت
  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: "Main Branch" },
  });

  const owner = await prisma.user.update({
    where: { id: tenant.users[0].id },
    data: { branchId: branch.id },
  });

  await trackPlatformEvent({ type: "SIGNUP", tenantId: tenant.id });

  return issueTokens(owner.id, tenant.id, owner.role, owner.branchId, owner.isSuperAdmin, false);
}

interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput) {
  // isLinkedCompany: false - عشان لو الشخص ده مالك أكتر من شركة، بنسجّله
  // دايمًا في حساب "الهوم" بتاعه بالإيميل/الباسورد، مش في أي شركة
  // إضافية عنده نفس الإيميل بالظبط (السويتش بينهم بيتم من واجهة منفصلة)
  const user = await prisma.user.findFirst({ where: { email: input.email, isActive: true, isLinkedCompany: false } });
  if (!user) throw new Error("Invalid credentials");

  if (!user.passwordHash) {
    throw new Error("This account uses Google Sign-In — use the \"Continue with Google\" button instead.");
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw new Error("Invalid credentials");

  await trackPlatformEvent({ type: "LOGIN", tenantId: user.tenantId });

  return issueTokens(user.id, user.tenantId, user.role, user.branchId, user.isSuperAdmin, user.isAgencyStaff);
}

// تجديد حقيقي مع تدوير (Rotation): التوكن القديم بيتلغى فورًا،
// وبيتصدر واحد جديد بدله - عشان لو حد سرق refresh token قديم مش
// هيقدر يستخدمه تاني بمجرد ما صاحبه الحقيقي جدّد جلسته مرة واحدة
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

  const newRefreshToken = signRefreshToken(user.id);

  // إبطال القديم وتسجيل الجديد في نفس اللحظة - مش نداءين منفصلين
  // ممكن يسيبوا نافذة زمنية فيها التوكنين شغالين مع بعض
  await prisma.$transaction([
    prisma.refreshToken.delete({ where: { token: refreshToken } }),
    prisma.refreshToken.create({
      data: { userId: user.id, token: newRefreshToken, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    }),
  ]);

  return { accessToken, refreshToken: newRefreshToken };
}

async function issueTokens(userId: string, tenantId: string, role: string, branchId: string | null, isSuperAdmin: boolean, isAgencyStaff: boolean) {
  const accessToken = signAccessToken({ userId, tenantId, role, branchId, isSuperAdmin });
  const refreshToken = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      userId,
      token: refreshToken,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 يوم
    },
  });

  return { accessToken, refreshToken, tenantId, role, isSuperAdmin, isAgencyStaff };
}

// تسجيل دخول حقيقي بحساب جوجل - لحساب موجود بالفعل بنفس الإيميل.
// لو الإيميل ده مسجّل بباسورد عادي (مش جوجل)، بنربطهم ببعض تلقائيًا
// عشان العميل يقدر يدخل بأي طريقة من الاتنين بعد كده
export async function loginWithGoogle(googleId: string, email: string, name: string) {
  let user = await prisma.user.findFirst({ where: { googleId } });

  if (!user) {
    user = await prisma.user.findFirst({ where: { email, isActive: true, isLinkedCompany: false } });
    if (user) {
      // نفس الإيميل موجود بحساب عادي - نربطه بجوجل عشان يستخدم الاتنين
      user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
    }
  }

  if (!user) {
    throw new Error("No account found with this Google email — sign up first.");
  }

  await trackPlatformEvent({ type: "LOGIN", tenantId: user.tenantId });

  return issueTokens(user.id, user.tenantId, user.role, user.branchId, user.isSuperAdmin, user.isAgencyStaff);
}

interface GoogleSignupInput {
  companyName: string;
  industry: "RETAIL" | "SERVICES" | "HOSPITALITY" | "REAL_ESTATE" | "SALONS";
  googleId: string;
  email: string;
  name: string;
}

// تسجيل شركة جديدة حقيقي بحساب جوجل - نفس منطق التسجيل العادي بالظبط
// (تجربة مجانية 24 ساعة + فرع افتراضي)، لكن من غير باسورد خالص
export async function registerTenantWithGoogle(input: GoogleSignupInput) {
  const existing = await prisma.user.findFirst({ where: { email: input.email } });
  if (existing) throw new Error("Email already in use");

  const slug = await generateUniqueSlug(input.companyName);
  const trialExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const tenant = await prisma.tenant.create({
    data: {
      name: input.companyName,
      industry: input.industry,
      slug,
      trialExpiresAt,
      users: {
        create: {
          name: input.name,
          email: input.email,
          googleId: input.googleId,
          role: "OWNER",
        },
      },
    },
    include: { users: true },
  });

  const branch = await prisma.branch.create({
    data: { tenantId: tenant.id, name: "Main Branch" },
  });

  const owner = await prisma.user.update({
    where: { id: tenant.users[0].id },
    data: { branchId: branch.id },
  });

  await trackPlatformEvent({ type: "SIGNUP", tenantId: tenant.id });

  return issueTokens(owner.id, tenant.id, owner.role, owner.branchId, owner.isSuperAdmin, false);
}
