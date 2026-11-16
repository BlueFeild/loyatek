import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";

// كل كلام Prisma بتاع العقارات هنا بس - وكل استعلام مربوط بـ tenantId

const SUMMARY_SELECT = {
  id: true,
  title: true,
  purpose: true,
  propertyType: true,
  status: true,
  price: true,
  rentPeriod: true,
  areaSqm: true,
  bedrooms: true,
  bathrooms: true,
  parking: true,
  furnished: true,
  location: true,
  featured: true,
  sortOrder: true,
  views: true,
  createdAt: true,
  updatedAt: true,
  photos: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.PropertyListingSelect;

const DETAIL_SELECT = { ...SUMMARY_SELECT, mapUrl: true, description: true, features: true } satisfies Prisma.PropertyListingSelect;

export class PropertiesRepository {
  // ---------- الإعدادات ----------
  async settings(tenantId: string) {
    const found = await prisma.propertySettings.findUnique({ where: { tenantId } });
    if (found) return found;
    try {
      return await prisma.propertySettings.create({ data: { tenantId } });
    } catch {
      // طلبين في نفس اللحظة: اللي خسر يقرا الصف اللي اتعمل
      return prisma.propertySettings.findUniqueOrThrow({ where: { tenantId } });
    }
  }

  async updateSettings(tenantId: string, data: Prisma.PropertySettingsUpdateInput) {
    await this.settings(tenantId);
    return prisma.propertySettings.update({ where: { tenantId }, data });
  }

  // ---------- العقارات ----------
  listSummaries(tenantId: string, opts: { publicOnly?: boolean } = {}) {
    return prisma.propertyListing.findMany({
      where: { tenantId, ...(opts.publicOnly ? { status: { not: "HIDDEN" } } : {}) },
      select: SUMMARY_SELECT,
      orderBy: [{ featured: "desc" }, { sortOrder: "asc" }, { createdAt: "desc" }],
      take: 600,
    });
  }

  count(tenantId: string) {
    return prisma.propertyListing.count({ where: { tenantId } });
  }

  findDetail(tenantId: string, id: string, opts: { publicOnly?: boolean } = {}) {
    return prisma.propertyListing.findFirst({
      where: { id, tenantId, ...(opts.publicOnly ? { status: { not: "HIDDEN" } } : {}) },
      select: DETAIL_SELECT,
    });
  }

  findRaw(tenantId: string, id: string) {
    return prisma.propertyListing.findFirst({ where: { id, tenantId } });
  }

  create(tenantId: string, data: Omit<Prisma.PropertyListingUncheckedCreateInput, "tenantId">) {
    return prisma.propertyListing.create({ data: { ...data, tenantId }, select: { id: true } });
  }

  async update(tenantId: string, id: string, data: Prisma.PropertyListingUpdateManyMutationInput) {
    const r = await prisma.propertyListing.updateMany({ where: { id, tenantId }, data });
    return r.count > 0;
  }

  async remove(tenantId: string, id: string) {
    const r = await prisma.propertyListing.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }

  incrementViews(tenantId: string, id: string) {
    return prisma.propertyListing.updateMany({ where: { id, tenantId }, data: { views: { increment: 1 } } });
  }

  // نسخة كاملة (بالصور) في transaction واحدة
  async duplicate(tenantId: string, id: string, title: string) {
    return prisma.$transaction(async (tx) => {
      const src = await tx.propertyListing.findFirst({ where: { id, tenantId }, include: { photos: { orderBy: { sortOrder: "asc" } } } });
      if (!src) return null;
      const copy = await tx.propertyListing.create({
        data: {
          tenantId,
          title,
          purpose: src.purpose,
          propertyType: src.propertyType,
          status: "HIDDEN",
          price: src.price,
          rentPeriod: src.rentPeriod,
          areaSqm: src.areaSqm,
          bedrooms: src.bedrooms,
          bathrooms: src.bathrooms,
          parking: src.parking,
          furnished: src.furnished,
          location: src.location,
          mapUrl: src.mapUrl,
          description: src.description,
          features: src.features,
          featured: false,
          sortOrder: src.sortOrder,
        },
        select: { id: true },
      });
      if (src.photos.length) {
        await tx.propertyPhoto.createMany({
          data: src.photos.map((p, i) => ({ tenantId, listingId: copy.id, dataUrl: p.dataUrl, sortOrder: i })),
        });
      }
      return copy;
    });
  }

  // ---------- الصور ----------
  photoIds(tenantId: string, listingId: string) {
    return prisma.propertyPhoto
      .findMany({ where: { tenantId, listingId }, select: { id: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
      .then((r) => r.map((p) => p.id));
  }

  // بيقفل العقار عشان رفعين في نفس اللحظة مايعدّوش حد الـ 30
  async addPhoto(tenantId: string, listingId: string, dataUrl: string, max: number): Promise<{ id: string } | "LIMIT" | null> {
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM property_listings WHERE id = ${listingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      if (!locked.length) return null;
      const agg = await tx.propertyPhoto.aggregate({ where: { listingId, tenantId }, _count: true, _max: { sortOrder: true } });
      if (agg._count >= max) return "LIMIT" as const;
      return tx.propertyPhoto.create({
        data: { tenantId, listingId, dataUrl, sortOrder: (agg._max.sortOrder ?? -1) + 1 },
        select: { id: true },
      });
    }, { maxWait: 15_000, timeout: 20_000 });
  }

  async deletePhoto(tenantId: string, listingId: string, photoId: string) {
    const r = await prisma.propertyPhoto.deleteMany({ where: { id: photoId, listingId, tenantId } });
    return r.count > 0;
  }

  async reorderPhotos(tenantId: string, listingId: string, ids: string[]) {
    await prisma.$transaction(
      ids.map((id, i) => prisma.propertyPhoto.updateMany({ where: { id, listingId, tenantId }, data: { sortOrder: i } }))
    );
  }

  photo(tenantId: string, photoId: string, opts: { publicOnly?: boolean } = {}) {
    return prisma.propertyPhoto.findFirst({
      where: { id: photoId, tenantId, ...(opts.publicOnly ? { listing: { status: { not: "HIDDEN" } } } : {}) },
      select: { id: true, dataUrl: true, createdAt: true },
    });
  }

  // ---------- الاستفسارات ----------
  listInquiries(tenantId: string) {
    return prisma.propertyInquiry.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 500 });
  }

  titlesFor(tenantId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as { id: string; title: string }[]);
    return prisma.propertyListing.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, title: true } });
  }

  async setInquiryStatus(tenantId: string, id: string, status: string) {
    const r = await prisma.propertyInquiry.updateMany({ where: { id, tenantId }, data: { status } });
    return r.count > 0;
  }

  createInquiry(data: { tenantId: string; listingId: string | null; name: string; phone: string; email: string | null; message: string | null }) {
    return prisma.propertyInquiry.create({ data });
  }

  tenantBySlug(slug: string) {
    return prisma.tenant.findUnique({ where: { slug } });
  }
}
