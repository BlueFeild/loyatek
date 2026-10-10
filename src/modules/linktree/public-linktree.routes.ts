import { Router } from "express";
import { prisma } from "../../config/db";
import { isModuleActive } from "../../utils/modules";

// راوتر عام بالكامل - أي حد يقدر يفتح صفحة الينكتري من غير حساب،
// بالظبط زي منطق الكتالوج والحجز العامين
export const publicLinktreeRouter = Router();

async function findTenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  // الرابط العام يشتغل بس لو مشترك فعليًا في linktree وماكانش انتهى
  // الاشتراك (مش وقت التجربة المجانية)
  if (!tenant || !isModuleActive(tenant, "linktree")) return null;
  return tenant;
}

publicLinktreeRouter.get("/:slug", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "This page isn't available" });

  const [settings, links] = await Promise.all([
    prisma.linktreeSettings.findUnique({ where: { tenantId: tenant.id } }),
    prisma.linktreeLink.findMany({ where: { tenantId: tenant.id }, orderBy: { sortOrder: "asc" } }),
  ]);

  res.json({
    displayName: settings?.displayName ?? tenant.name,
    bio: settings?.bio ?? "",
    avatarDataUrl: settings?.avatarDataUrl ?? null,
    themeColor: settings?.themeColor ?? "#38BDF8",
    backgroundColor: settings?.backgroundColor ?? "#0f172a",
    links: links.map((l: any) => ({ id: l.id, label: l.label, url: l.url, kind: l.kind, fileName: l.fileName, fileSize: l.fileSize })),
  });
});

// تسجيل نقرة حقيقية - بتزيد فعليًا في قاعدة البيانات كل ما زائر
// يدوس على رابط، مش رقم وهمي بيتحسب في المتصفح
publicLinktreeRouter.post("/:slug/click/:linkId", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "This page isn't available" });

  const link = await prisma.linktreeLink.findFirst({ where: { id: req.params.linkId, tenantId: tenant.id } });
  if (!link) return res.status(404).json({ error: "Link not found" });

  await prisma.linktreeLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } });
  res.json({ ok: true });
});

// تحميل ملف مرفوع - attachment + nosniff عشان الملف مايتفتحش كصفحة
// نشطة في المتصفح، وبيتحسب كنقرة حقيقية
publicLinktreeRouter.get("/:slug/files/:linkId", async (req, res) => {
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "This page isn't available" });

  const link = await prisma.linktreeLink.findFirst({
    where: { id: req.params.linkId, tenantId: tenant.id, kind: "FILE" },
    include: { file: true },
  });
  if (!link || !link.file) return res.status(404).json({ error: "File not found" });

  await prisma.linktreeLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } });
  res.setHeader("Content-Type", link.file.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename="${(link.fileName ?? "file").replace(/[^\w.\- ]/g, "_")}"`);
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(Buffer.from(link.file.data));
});
