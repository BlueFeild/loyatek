import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// عرض كل المستخدمين في نفس الشركة بس (معزول حسب tenantId)
usersRouter.get("/", async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.auth!.tenantId },
    select: { id: true, name: true, email: true, role: true, branchId: true, isActive: true },
  });
  res.json(users);
});

const inviteSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "MANAGER", "STAFF"]),
  branchId: z.string().uuid().optional(),
});

// إضافة موظف جديد للشركة - يتطلب صلاحية OWNER أو ADMIN
usersRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  try {
    const user = await prisma.user.create({
      data: {
        tenantId: req.auth!.tenantId,
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash,
        role: parsed.data.role,
        branchId: parsed.data.branchId,
      },
      select: { id: true, name: true, email: true, role: true },
    });
    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json({ error: "Email already used in this company" });
  }
});
