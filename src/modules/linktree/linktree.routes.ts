import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const linktreeRouter = Router();
linktreeRouter.use(requireAuth);

async function getOrCreateSettings(tenantId: string) {
  const existing = await prisma.linktreeSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.linktreeSettings.create({ data: { tenantId } });
}

linktreeRouter.get("/settings", async (req, res) => {
  res.json(await getOrCreateSettings(req.auth!.tenantId));
});

const updateSettingsSchema = z.object({
  displayName: z.string().min(1).optional(),
  bio: z.string().optional(),
  avatarDataUrl: z.string().nullable().optional(),
  // شكل اللوجو في الصفحة (في النص دايمًا) - الفرونت بيقرا القيم بـ readAvatarStyle
  avatarStyle: z
    .object({
      fit: z.enum(["cover", "contain"]),
      shape: z.enum(["circle", "rounded", "square"]),
      zoom: z.number().min(100).max(250),
      x: z.number().min(0).max(100),
      y: z.number().min(0).max(100),
    })
    .nullable()
    .optional(),
  themeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

linktreeRouter.patch("/settings", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateSettings(req.auth!.tenantId);
  const updated = await prisma.linktreeSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: { ...parsed.data, avatarStyle: parsed.data.avatarStyle === null ? Prisma.DbNull : parsed.data.avatarStyle },
  });
  res.json(updated);
});

linktreeRouter.get("/links", async (req, res) => {
  const links = await prisma.linktreeLink.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { sortOrder: "asc" },
  });
  res.json(links);
});

// أيقونة اللينك: مفتاح أيقونة جاهزة (حروف بس، زي "facebook") أو "none"،
// أو صورة صغيرة مرفوعة (PNG/JPG/WEBP/GIF بس - من غير SVG) لحد ~300KB
const iconKeySchema = z.string().regex(/^[a-z0-9_-]{1,32}$/).nullable();
const iconImageSchema = z
  .string()
  .max(400_000, "Icon image is too large (max ~300 KB)")
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, "Icon must be a PNG, JPG, WEBP or GIF image")
  .nullable();

const createLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  icon: iconKeySchema.optional(),
  iconDataUrl: iconImageSchema.optional(),
});

linktreeRouter.post("/links", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid link" });

  const maxOrder = await prisma.linktreeLink.aggregate({
    where: { tenantId: req.auth!.tenantId },
    _max: { sortOrder: true },
  });

  const link = await prisma.linktreeLink.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data, sortOrder: (maxOrder._max.sortOrder ?? -1) + 1 },
  });
  res.status(201).json(link);
});

// --- ملفات مرفوعة (PDF، صور، مستندات...) ---
// قايمة بيضاء بالأنواع (من غير svg/html عشان مايتحولوش لصفحات نشطة)،
// حد أقصى 20MB للملف و10 ملفات و100MB إجمالي للشركة (الملفات في الداتابيز)
export const LINKTREE_ALLOWED_FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
export const LINKTREE_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const LINKTREE_MAX_FILES = 10;
export const LINKTREE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// ويندوز ساعات بيسمّي نفس النوع باسم تاني (ZIP مثلًا)
const MIME_ALIASES: Record<string, string> = { "application/x-zip-compressed": "application/zip", "application/x-zip": "application/zip" };

const uploadFileSchema = z.object({
  label: z.string().trim().min(1).max(120),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string(),
  dataBase64: z.string().min(1),
});

linktreeRouter.post("/links/file", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = uploadFileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { label, dataBase64 } = parsed.data;
  const mimeType = MIME_ALIASES[parsed.data.mimeType] ?? parsed.data.mimeType;
  // اسم الملف للعرض والتحميل بس: بنشيل أي مسارات/رموز تحكم
  const fileName = parsed.data.fileName.replace(/[\\/\r\n"]/g, "_");

  if (!LINKTREE_ALLOWED_FILE_TYPES[mimeType]) {
    return res.status(400).json({ error: "This file type isn't supported. Use PDF, image, Office document, ZIP, TXT or CSV." });
  }
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.length === 0) return res.status(400).json({ error: "The file is empty" });
  if (buffer.length > LINKTREE_MAX_FILE_BYTES) {
    return res.status(413).json({ error: "File is too large (max 20 MB)" });
  }

  const tenantId = req.auth!.tenantId;
  const existing = await prisma.linktreeLink.count({ where: { tenantId, kind: "FILE" } });
  if (existing >= LINKTREE_MAX_FILES) {
    return res.status(400).json({ error: `You can upload up to ${LINKTREE_MAX_FILES} files. Delete one first.` });
  }
  const used = await prisma.linktreeLink.aggregate({ where: { tenantId, kind: "FILE" }, _sum: { fileSize: true } });
  if ((used._sum.fileSize ?? 0) + buffer.length > LINKTREE_MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: "Your files would go over 100 MB in total. Delete a file first." });
  }

  const maxOrder = await prisma.linktreeLink.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
  const link = await prisma.linktreeLink.create({
    data: {
      tenantId,
      label,
      url: "",
      kind: "FILE",
      fileName,
      fileSize: buffer.length,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      file: { create: { mimeType, data: buffer } },
    },
  });
  res.status(201).json(link);
});

const updateLinkSchema = z.object({
  label: z.string().min(1).optional(),
  url: z.string().url().optional(),
  sortOrder: z.number().int().optional(),
  icon: iconKeySchema.optional(),
  iconDataUrl: iconImageSchema.optional(),
});

linktreeRouter.patch("/links/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid link" });

  const link = await prisma.linktreeLink.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!link) return res.status(404).json({ error: "Link not found" });

  const updated = await prisma.linktreeLink.update({ where: { id: link.id }, data: parsed.data });
  res.json(updated);
});

linktreeRouter.delete("/links/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const link = await prisma.linktreeLink.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!link) return res.status(404).json({ error: "Link not found" });

  await prisma.linktreeLink.delete({ where: { id: link.id } });
  res.json({ ok: true });
});
