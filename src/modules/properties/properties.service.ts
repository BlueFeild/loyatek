import { createHash } from "crypto";
import { AppError, NotFoundError } from "../../core/errors";
import { getTenantMoney, rateFor } from "../../utils/money";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { isModuleLive } from "../../utils/platform-config";
import { PropertiesRepository } from "./properties.repository";
import {
  MAX_LISTINGS,
  MAX_PHOTOS,
  decodeImageDataUrl,
  isSamePhotoSet,
  normalizeListing,
  toSummary,
  type ListingInput,
} from "./properties.schemas";

type Settings = Awaited<ReturnType<PropertiesRepository["settings"]>>;
type Detail = NonNullable<Awaited<ReturnType<PropertiesRepository["findDetail"]>>>;

export interface ImageBytes {
  mime: string;
  bytes: Buffer;
  etag: string;
}

const notFound = () => new NotFoundError("This property wasn't found");

export class PropertiesService {
  constructor(private readonly repo = new PropertiesRepository()) {}

  // ---------- لوحة التاجر ----------
  async getSettings(tenantId: string) {
    return this.repo.settings(tenantId);
  }

  async updateSettings(tenantId: string, patch: Record<string, unknown>) {
    return this.repo.updateSettings(tenantId, patch);
  }

  async listListings(tenantId: string) {
    const rows = await this.repo.listSummaries(tenantId);
    return rows.map((r) => toSummary(r));
  }

  async getListing(tenantId: string, id: string) {
    const row = await this.repo.findDetail(tenantId, id);
    if (!row) throw notFound();
    return this.detailView(row);
  }

  async createListing(tenantId: string, input: ListingInput & { title: string }) {
    if ((await this.repo.count(tenantId)) >= MAX_LISTINGS) {
      throw new AppError(400, "LISTING_LIMIT", `You can have up to ${MAX_LISTINGS} properties. Delete old ones to add more.`);
    }
    const data = normalizeListing(input);
    const created = await this.repo.create(tenantId, { ...data, title: input.title });
    return this.getListing(tenantId, created.id);
  }

  async updateListing(tenantId: string, id: string, input: ListingInput) {
    const current = await this.repo.findRaw(tenantId, id);
    if (!current) throw notFound();
    const data = normalizeListing(input, current.purpose);
    await this.repo.update(tenantId, id, data);
    return this.getListing(tenantId, id);
  }

  async deleteListing(tenantId: string, id: string) {
    if (!(await this.repo.remove(tenantId, id))) throw notFound();
  }

  async duplicateListing(tenantId: string, id: string) {
    if ((await this.repo.count(tenantId)) >= MAX_LISTINGS) {
      throw new AppError(400, "LISTING_LIMIT", `You can have up to ${MAX_LISTINGS} properties. Delete old ones to add more.`);
    }
    const src = await this.repo.findRaw(tenantId, id);
    if (!src) throw notFound();
    const copy = await this.repo.duplicate(tenantId, id, `${src.title} (copy)`.slice(0, 140));
    if (!copy) throw notFound();
    return this.getListing(tenantId, copy.id);
  }

  async addPhoto(tenantId: string, listingId: string, dataUrl: string) {
    const res = await this.repo.addPhoto(tenantId, listingId, dataUrl, MAX_PHOTOS);
    if (res === null) throw notFound();
    if (res === "LIMIT") throw new AppError(400, "PHOTO_LIMIT", `Up to ${MAX_PHOTOS} photos per property.`);
    return { id: res.id, photoIds: await this.repo.photoIds(tenantId, listingId) };
  }

  async deletePhoto(tenantId: string, listingId: string, photoId: string) {
    if (!(await this.repo.deletePhoto(tenantId, listingId, photoId))) throw new NotFoundError("Photo not found");
    return { photoIds: await this.repo.photoIds(tenantId, listingId) };
  }

  async reorderPhotos(tenantId: string, listingId: string, ids: string[]) {
    if (!(await this.repo.findRaw(tenantId, listingId))) throw notFound();
    const current = await this.repo.photoIds(tenantId, listingId);
    if (!isSamePhotoSet(current, ids)) throw new AppError(400, "PHOTO_ORDER", "The photo list changed — please reload and try again.");
    await this.repo.reorderPhotos(tenantId, listingId, ids);
    return { photoIds: ids };
  }

  async photoBytes(tenantId: string, photoId: string, publicOnly: boolean): Promise<ImageBytes | null> {
    const p = await this.repo.photo(tenantId, photoId, { publicOnly });
    const img = decodeImageDataUrl(p?.dataUrl);
    if (!p || !img) return null;
    // الصورة نفسها مابتتغيرش (التعديل = صورة جديدة) -> الـ id يكفي
    return { ...img, etag: `"ph-${p.id}"` };
  }

  async listInquiries(tenantId: string) {
    const rows = await this.repo.listInquiries(tenantId);
    const ids = [...new Set(rows.map((r) => r.listingId).filter((x): x is string => !!x))];
    const titles = new Map((await this.repo.titlesFor(tenantId, ids)).map((t) => [t.id, t.title]));
    return rows.map((r) => ({ ...r, listingTitle: r.listingId ? titles.get(r.listingId) ?? null : null }));
  }

  async setInquiryStatus(tenantId: string, id: string, status: string) {
    if (!(await this.repo.setInquiryStatus(tenantId, id, status))) throw new NotFoundError("Enquiry not found");
  }

  // ---------- الصفحة العامة ----------
  async liveTenant(slug: string) {
    const tenant = await this.repo.tenantBySlug(slug);
    if (!tenant || !(await isModuleLive(tenant, "properties"))) throw new NotFoundError("This page isn't available");
    return tenant;
  }

  async publicPage(slug: string) {
    const tenant = await this.liveTenant(slug);
    const [settings, rows, money] = await Promise.all([this.repo.settings(tenant.id), this.repo.listSummaries(tenant.id, { publicOnly: true }), getTenantMoney(tenant.id)]);
    return {
      page: this.publicSettings(slug, tenant.name, settings),
      currency: money.currency,
      rate: rateFor(money.currency, money.rates),
      listings: rows.map((r) => toSummary(r, { hidePrice: !settings.showPrices })),
    };
  }

  async publicListing(slug: string, id: string) {
    const tenant = await this.liveTenant(slug);
    const row = await this.repo.findDetail(tenant.id, id, { publicOnly: true });
    if (!row) throw notFound();
    const [settings, money] = await Promise.all([this.repo.settings(tenant.id), getTenantMoney(tenant.id)]);
    await this.repo.incrementViews(tenant.id, id);
    return {
      page: this.publicSettings(slug, tenant.name, settings),
      currency: money.currency,
      rate: rateFor(money.currency, money.rates),
      listing: this.detailView(row, { hidePrice: !settings.showPrices }),
    };
  }

  async publicPhoto(slug: string, photoId: string) {
    const tenant = await this.liveTenant(slug);
    return this.photoBytes(tenant.id, photoId, true);
  }

  async publicBrandImage(slug: string, kind: "logo" | "cover"): Promise<ImageBytes | null> {
    const tenant = await this.liveTenant(slug);
    const s = await this.repo.settings(tenant.id);
    const dataUrl = kind === "logo" ? s.logoDataUrl : s.coverDataUrl;
    const img = decodeImageDataUrl(dataUrl);
    if (!img || !dataUrl) return null;
    return { ...img, etag: `"${kind}-${createHash("sha1").update(dataUrl).digest("hex").slice(0, 20)}"` };
  }

  async createInquiry(slug: string, input: { listingId?: string | null; name: string; phone: string; email?: string | null; message?: string | null }) {
    const tenant = await this.liveTenant(slug);
    let listingTitle: string | null = null;
    if (input.listingId) {
      const listing = await this.repo.findDetail(tenant.id, input.listingId, { publicOnly: true });
      if (!listing) throw notFound();
      listingTitle = listing.title;
    }
    const inquiry = await this.repo.createInquiry({
      tenantId: tenant.id,
      listingId: input.listingId ?? null,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      message: input.message ?? null,
    });

    const about = listingTitle ? ` about "${listingTitle}"` : "";
    // نوع الإشعار enum ثابت في الداتابيز - CATALOG_ORDER أقرب نوع (طلب جديد من صفحة عامة)
    await createNotification({
      tenantId: tenant.id,
      type: "CATALOG_ORDER",
      title: "New property enquiry",
      body: `${input.name} (${input.phone}) asked${about}.`,
      link: "/properties?tab=enquiries",
    });
    const settings = await this.repo.settings(tenant.id);
    if (isValidEmail(settings.email)) {
      const lines = [
        `New enquiry${about}`,
        "",
        `Name: ${input.name}`,
        `Phone: ${input.phone}`,
        input.email ? `Email: ${input.email}` : null,
        input.message ? `Message: ${input.message}` : null,
        "",
        "Open your dashboard → Properties → Enquiries to reply.",
      ].filter((l) => l !== null);
      sendEmail(settings.email, `New property enquiry from ${input.name}`, lines.join("\n")).catch(() => {});
    }
    return { id: inquiry.id };
  }

  // ---------- مساعدين ----------
  private detailView(row: Detail, opts: { hidePrice?: boolean } = {}) {
    return {
      ...toSummary(row, opts),
      mapUrl: row.mapUrl,
      description: row.description,
      features: row.features,
      photoIds: row.photos.map((p) => p.id),
    };
  }

  private publicSettings(slug: string, tenantName: string, s: Settings) {
    const v = s.updatedAt.getTime();
    const base = `/api/public/properties/${encodeURIComponent(slug)}`;
    return {
      slug,
      brandName: s.brandName || tenantName,
      about: s.about,
      logoUrl: s.logoDataUrl ? `${base}/logo?v=${v}` : null,
      coverUrl: s.coverDataUrl ? `${base}/cover?v=${v}` : null,
      accentColor: s.accentColor,
      whatsapp: s.whatsapp,
      phone: s.phone,
      email: s.email,
      showPrices: s.showPrices,
    };
  }
}

