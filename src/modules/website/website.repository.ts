import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";

// كل كلام Prisma بتاع الموقع التعريفي هنا بس - وكل استعلام مربوط بـ tenantId

export class WebsiteRepository {
  // ---------- الإعدادات ----------
  async settings(tenantId: string) {
    const found = await prisma.websiteSettings.findUnique({ where: { tenantId } });
    if (found) return found;
    try {
      return await prisma.websiteSettings.create({ data: { tenantId } });
    } catch {
      // طلبين في نفس اللحظة: اللي خسر يقرا الصف اللي اتعمل
      return prisma.websiteSettings.findUniqueOrThrow({ where: { tenantId } });
    }
  }

  async updateSettings(tenantId: string, data: Prisma.WebsiteSettingsUpdateInput) {
    await this.settings(tenantId);
    return prisma.websiteSettings.update({ where: { tenantId }, data });
  }

  tenantBySlug(slug: string) {
    return prisma.tenant.findUnique({ where: { slug } });
  }

  tenantName(tenantId: string) {
    return prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } });
  }

  ownerEmail(tenantId: string) {
    return prisma.user.findFirst({ where: { tenantId, role: "OWNER", isActive: true }, select: { email: true }, orderBy: { createdAt: "asc" } });
  }

  // ---------- الصور ----------
  photoList(tenantId: string) {
    return prisma.websitePhoto.findMany({ where: { tenantId }, select: { id: true, kind: true, createdAt: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  }

  photoCount(tenantId: string) {
    return prisma.websitePhoto.count({ where: { tenantId } });
  }

  addPhoto(tenantId: string, kind: string, dataUrl: string) {
    return prisma.websitePhoto.create({ data: { tenantId, kind, dataUrl }, select: { id: true, kind: true } });
  }

  photo(tenantId: string, id: string) {
    return prisma.websitePhoto.findFirst({ where: { id, tenantId }, select: { id: true, dataUrl: true } });
  }

  async deletePhoto(tenantId: string, id: string) {
    const r = await prisma.websitePhoto.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }

  // صور اترفعت ومحدش استخدمها (أقدم من يوم - عشان مانمسحش صورة لسه بتترفع)
  deleteOrphans(tenantId: string, keep: string[], olderThan: Date) {
    return prisma.websitePhoto.deleteMany({ where: { tenantId, id: { notIn: keep }, createdAt: { lt: olderThan } } });
  }

  // ---------- الرسايل ----------
  listInquiries(tenantId: string) {
    return prisma.websiteInquiry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 500 });
  }

  countNewInquiries(tenantId: string) {
    return prisma.websiteInquiry.count({ where: { tenantId, status: "NEW" } });
  }

  createInquiry(data: Prisma.WebsiteInquiryUncheckedCreateInput) {
    return prisma.websiteInquiry.create({ data, select: { id: true } });
  }

  async setInquiryStatus(tenantId: string, id: string, status: string) {
    const r = await prisma.websiteInquiry.updateMany({ where: { id, tenantId }, data: { status } });
    return r.count > 0;
  }

  async deleteInquiry(tenantId: string, id: string) {
    const r = await prisma.websiteInquiry.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }

  // ---------- الزيارات ----------
  addVisit(tenantId: string, day: string) {
    return prisma.websiteVisitDay.upsert({
      where: { tenantId_day: { tenantId, day } },
      create: { tenantId, day, count: 1 },
      update: { count: { increment: 1 } },
    });
  }

  visits(tenantId: string, days: string[]) {
    return prisma.websiteVisitDay.findMany({ where: { tenantId, day: { in: days } }, select: { day: true, count: true } });
  }
}
