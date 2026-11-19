import { createHash } from "crypto";
import { AppError, NotFoundError } from "../../core/errors";
import { getTenantMoney, rateFor } from "../../utils/money";
import { createNotification } from "../notifications/notifications.service";
import { isValidEmail, sendEmail } from "../../utils/email";
import { isModuleLive } from "../../utils/platform-config";
import { WebsiteRepository } from "./website.repository";
import {
  LIMITS,
  dayKey,
  decodeImageDataUrl,
  keepKnownPhotos,
  lastDays,
  readContent,
  referencedPhotoIds,
  type SettingsInput,
  type WebsiteContent,
} from "./website.schemas";

type Settings = Awaited<ReturnType<WebsiteRepository["settings"]>>;
type Tenant = NonNullable<Awaited<ReturnType<WebsiteRepository["tenantBySlug"]>>>;

export interface ImageBytes {
  mime: string;
  bytes: Buffer;
  etag: string;
}

// صفحات الشركة التانية على BlueField (بتظهر كأزرار في الموقع لو الخدمة شغالة)
const SIBLINGS: { module: string; kind: string; path: (slug: string) => string }[] = [
  { module: "booking", kind: "booking", path: (s) => `/book/${s}` },
  { module: "catalog", kind: "menu", path: (s) => `/menu/${s}` },
  { module: "store", kind: "store", path: (s) => `/shop/${s}` },
  { module: "properties", kind: "properties", path: (s) => `/p/${s}` },
  { module: "tickets", kind: "events", path: (s) => `/events/${s}` },
  { module: "linktree", kind: "links", path: (s) => `/l/${s}` },
];

const ORPHAN_AGE_MS = 24 * 3600 * 1000;

export class WebsiteService {
  constructor(private readonly repo = new WebsiteRepository()) {}

  // ---------- لوحة التاجر ----------
  async overview(tenantId: string) {
    const [settings, photos, newMessages, visits] = await Promise.all([
      this.repo.settings(tenantId),
      this.repo.photoList(tenantId),
      this.repo.countNewInquiries(tenantId),
      this.visitStats(tenantId),
    ]);
    return { settings: this.settingsView(settings), photos: photos.map((p) => ({ id: p.id, kind: p.kind })), newMessages, visits };
  }

  async updateSettings(tenantId: string, patch: SettingsInput) {
    const data: Record<string, unknown> = { ...patch, savedAt: new Date() };
    if (patch.pageStyle) {
      const current = await this.repo.settings(tenantId);
      data.pageStyle = { ...((current.pageStyle as object) ?? {}), ...patch.pageStyle };
    }
    return this.settingsView(await this.repo.updateSettings(tenantId, data));
  }

  async saveContent(tenantId: string, content: WebsiteContent) {
    const photos = await this.repo.photoList(tenantId);
    const clean = keepKnownPhotos(content, new Set(photos.map((p) => p.id)));
    const saved = await this.repo.updateSettings(tenantId, { content: clean as object, savedAt: new Date() });
    // صور قديمة محدش بيستخدمها -> تتمسح
    await this.repo.deleteOrphans(tenantId, referencedPhotoIds(clean), new Date(Date.now() - ORPHAN_AGE_MS));
    return this.settingsView(saved);
  }

  async addPhoto(tenantId: string, kind: string, dataUrl: string) {
    if ((await this.repo.photoCount(tenantId)) >= LIMITS.photosTotal) {
      throw new AppError(400, "PHOTO_LIMIT", `You can keep up to ${LIMITS.photosTotal} photos on your website. Remove some first.`);
    }
    return this.repo.addPhoto(tenantId, kind, dataUrl);
  }

  async deletePhoto(tenantId: string, id: string) {
    if (!(await this.repo.deletePhoto(tenantId, id))) throw new NotFoundError("Photo not found");
    // نشيلها من المحتوى كمان
    const s = await this.repo.settings(tenantId);
    const photos = await this.repo.photoList(tenantId);
    const clean = keepKnownPhotos(readContent(s.content), new Set(photos.map((p) => p.id)));
    await this.repo.updateSettings(tenantId, { content: clean as object });
  }

  async photoBytes(tenantId: string, id: string): Promise<ImageBytes | null> {
    const p = await this.repo.photo(tenantId, id);
    const img = decodeImageDataUrl(p?.dataUrl);
    if (!p || !img) return null;
    // الصورة مابتتغيرش (التعديل = صورة جديدة) -> الـ id يكفي
    return { ...img, etag: `"wp-${p.id}"` };
  }

  listInquiries(tenantId: string) {
    return this.repo.listInquiries(tenantId);
  }

  async setInquiryStatus(tenantId: string, id: string, status: string) {
    if (!(await this.repo.setInquiryStatus(tenantId, id, status))) throw new NotFoundError("Message not found");
  }

  async deleteInquiry(tenantId: string, id: string) {
    if (!(await this.repo.deleteInquiry(tenantId, id))) throw new NotFoundError("Message not found");
  }

  async visitStats(tenantId: string) {
    const days = lastDays(30);
    const rows = await this.repo.visits(tenantId, days);
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const series = days.map((d) => ({ day: d, count: byDay.get(d) ?? 0 })).reverse();
    return { last30: series.reduce((n, d) => n + d.count, 0), last7: series.slice(-7).reduce((n, d) => n + d.count, 0), days: series };
  }

  // ---------- الصفحة العامة ----------
  // الخدمة لازم تكون شغالة (اشتراك حقيقي) والموقع منشور
  private async liveSite(slug: string): Promise<{ tenant: Tenant; settings: Settings }> {
    const tenant = await this.repo.tenantBySlug(slug);
    if (!tenant || !(await isModuleLive(tenant, "website"))) throw new NotFoundError("This website isn't available");
    const settings = await this.repo.settings(tenant.id);
    if (!settings.published) throw new AppError(404, "NOT_PUBLISHED", "This website isn't published yet");
    return { tenant, settings };
  }

  async publicSite(slug: string) {
    const { tenant, settings } = await this.liveSite(slug);
    const money = await getTenantMoney(tenant.id);
    const content = readContent(settings.content);
    const pages: { kind: string; url: string }[] = [];
    if (content.otherPages && tenant.slug) {
      for (const s of SIBLINGS) if (await isModuleLive(tenant, s.module)) pages.push({ kind: s.kind, url: s.path(tenant.slug) });
    }
    const v = settings.updatedAt.getTime();
    const base = `/api/public/website/${encodeURIComponent(slug)}`;
    return {
      slug,
      brandName: settings.brandName || tenant.name,
      template: settings.template,
      pageStyle: settings.pageStyle ?? {},
      language: settings.language,
      seoTitle: settings.seoTitle,
      seoDescription: settings.seoDescription,
      logoUrl: settings.logoDataUrl ? `${base}/logo?v=${v}` : null,
      coverUrl: settings.coverDataUrl ? `${base}/cover?v=${v}` : null,
      content,
      currency: money.currency,
      rate: rateFor(money.currency, money.rates),
      pages,
    };
  }

  async publicPhoto(slug: string, id: string) {
    const { tenant } = await this.liveSite(slug);
    return this.photoBytes(tenant.id, id);
  }

  async publicBrandImage(slug: string, kind: "logo" | "cover"): Promise<ImageBytes | null> {
    const { settings } = await this.liveSite(slug);
    const dataUrl = kind === "logo" ? settings.logoDataUrl : settings.coverDataUrl;
    const img = decodeImageDataUrl(dataUrl);
    if (!img || !dataUrl) return null;
    return { ...img, etag: `"${kind}-${createHash("sha1").update(dataUrl).digest("hex").slice(0, 20)}"` };
  }

  async createInquiry(slug: string, input: { name: string; phone: string; email: string; message: string }) {
    const { tenant, settings } = await this.liveSite(slug);
    const content = readContent(settings.content);
    if (!content.contact.form) throw new AppError(400, "FORM_OFF", "This website doesn't take messages here — please call or WhatsApp instead.");
    await this.repo.createInquiry({
      tenantId: tenant.id,
      name: input.name,
      phone: input.phone || null,
      email: input.email || null,
      message: input.message,
    });
    // نوع الإشعار enum ثابت في الداتابيز - CATALOG_ORDER أقرب نوع (رسالة جديدة من صفحة عامة)
    await createNotification({
      tenantId: tenant.id,
      type: "CATALOG_ORDER",
      title: "New message from your website",
      body: `${input.name}${input.phone ? ` (${input.phone})` : ""}: ${input.message.slice(0, 140)}`,
      link: "/website?tab=messages",
    });
    const to = isValidEmail(content.contact.email) ? content.contact.email : (await this.repo.ownerEmail(tenant.id))?.email;
    if (isValidEmail(to)) {
      const lines = [
        "New message from your website",
        "",
        `Name: ${input.name}`,
        input.phone ? `Phone: ${input.phone}` : null,
        input.email ? `Email: ${input.email}` : null,
        `Message: ${input.message}`,
        "",
        "Open your dashboard → Website → Messages to reply.",
      ].filter((l) => l !== null);
      sendEmail(to, `New website message from ${input.name}`, lines.join("\n")).catch(() => {});
    }
  }

  async addVisit(slug: string) {
    const { tenant } = await this.liveSite(slug);
    await this.repo.addVisit(tenant.id, dayKey());
  }

  // ---------- مساعدين ----------
  private settingsView(s: Settings) {
    return {
      published: s.published,
      template: s.template,
      pageStyle: (s.pageStyle as Record<string, unknown> | null) ?? {},
      content: readContent(s.content),
      brandName: s.brandName,
      logoDataUrl: s.logoDataUrl,
      coverDataUrl: s.coverDataUrl,
      seoTitle: s.seoTitle,
      seoDescription: s.seoDescription,
      language: s.language,
      savedAt: s.savedAt,
      updatedAt: s.updatedAt,
    };
  }
}
