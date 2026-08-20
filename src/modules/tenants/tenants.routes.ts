import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { generateUniqueSlug } from "../../utils/slug";

export const tenantsRouter = Router();

// كل الراوتس هنا محتاجة تسجيل دخول
tenantsRouter.use(requireAuth);

// جلب بيانات الشركة الحالية + الفروع (معزولة تلقائيًا حسب tenantId من الـ token)
tenantsRouter.get("/me", async (req, res) => {
  let tenant = await prisma.tenant.findUnique({
    where: { id: req.auth!.tenantId },
    include: { branches: true },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // شركات اتسجّلت قبل ما نضيف الرابط العام - نولّدها أول مرة بيدخلوا فيها
  if (!tenant.slug) {
    const slug = await generateUniqueSlug(tenant.name);
    tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { slug }, include: { branches: true } });
  }

  res.json(tenant);
});

const createBranchSchema = z.object({
  name: z.string().min(2),
  location: z.string().optional(),
});

// إضافة فرع جديد - يتطلب صلاحية OWNER أو ADMIN فقط
tenantsRouter.post("/branches", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createBranchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const branch = await prisma.branch.create({
    data: {
      tenantId: req.auth!.tenantId, // العزل التلقائي بين الشركات
      name: parsed.data.name,
      location: parsed.data.location,
    },
  });
  res.status(201).json(branch);
});

tenantsRouter.get("/branches", async (req, res) => {
  const branches = await prisma.branch.findMany({
    where: { tenantId: req.auth!.tenantId },
  });
  res.json(branches);
});

const updateVatSchema = z.object({ vatNumber: z.string().min(1) });

// تحديث الرقم الضريبي - مطلوب قبل ما تقدري تصدري فاتورة (بيدخل في QR الفاتورة)
tenantsRouter.patch("/vat-number", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateVatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tenant = await prisma.tenant.update({
    where: { id: req.auth!.tenantId },
    data: { vatNumber: parsed.data.vatNumber },
  });
  res.json(tenant);
});
