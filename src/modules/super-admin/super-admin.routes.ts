import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../config/db";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { ACCOUNT_STATUSES, ALL_MODULES, computeExpiryDate, isInGrace, isModuleActive, moduleExpiry } from "../../utils/modules";
import { clearAccessCache } from "../../utils/account-access";
import { clearPlatformConfigCache, getPlatformConfig } from "../../utils/platform-config";
import { MODULE_PRICES } from "../checkout/pricing";
import { isCurrencyCode } from "../../utils/money";
import { signAccessToken } from "../../utils/jwt";
import { generateUniqueSlug } from "../../utils/slug";
import { getPlatformAnalytics } from "../analytics/analytics.service";
import { createLinkedCompany } from "../tenants/company-creation.service";
import { buildInvoicePdf } from "./invoice-pdf.service";
import { activateSubscriptionOrder, syncOrderPayment } from "../checkout/order-activation";
import { createPasswordLink, emailTaken, generateTempPassword, sendEmailChangedNotice, sendOwnerInviteEmail, sendWelcomeEmail } from "../auth/account-links";
import { transferOwnership } from "../account/account.routes";

// كل موظفين الأجنسي (BlueField team) بيتسجلوا كـ Users جوه شركة
// داخلية واحدة ثابتة (مش شركة عميل حقيقية) - بننشئها أول مرة لو
// مش موجودة، وبعد كده بنعيد استخدام نفسها
async function getOrCreateAgencyHomeTenant() {
  const existing = await prisma.tenant.findFirst({ where: { slug: "bluefield-agency-team" } });
  if (existing) return existing;
  return prisma.tenant.create({
    data: {
      name: "BlueField Agency Team",
      industry: "SERVICES",
      slug: "bluefield-agency-team",
    },
  });
}

export const superAdminRouter = Router();

superAdminRouter.use(requireAuth, requireSuperAdmin);

// إيرادات حقيقية، أوردرات، وزيارات/تسجيلات/دخول حقيقية على مستوى
// المنصة كلها - آخر 30 يوم + إجمالي كل الوقت
superAdminRouter.get("/analytics", async (_req, res) => {
  const analytics = await getPlatformAnalytics();
  res.json(analytics);
});

// "إدارة نيابة عن شركة عميل" - بيدّي السوبر أدمن توكن حقيقي مربوط
// بشركة العميل نفسها (مش بشركة السوبر أدمن)، عشان أي حاجة يعملها
// (يضيف منيو، يضيف موعد...) تتسجّل فعليًا تحت شركة العميل الصح، مش
// تحت حساب السوبر أدمن بالغلط
superAdminRouter.post("/tenants/:id/impersonate", async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { users: true } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const owner = tenant.users.find((u: (typeof tenant.users)[number]) => u.role === "OWNER") ?? tenant.users[0];
  if (!owner) return res.status(400).json({ error: "This company has no users to manage as" });

  const accessToken = signAccessToken({
    userId: owner.id,
    tenantId: tenant.id,
    role: owner.role,
    branchId: owner.branchId,
    isSuperAdmin: false, // مهم - وقت الانتحال بيتصرف كتاجر عادي، مش سوبر أدمن
    impersonatedBy: req.auth!.userId,
  });

  res.json({ accessToken, tenantId: tenant.id, tenantName: tenant.name, role: owner.role });
});

// قائمة كل الشركات المسجّلة على المنصة - مع كل المستخدمين، الرابط العام،
// وإحصائيات استخدام حقيقية لكل خدمة (مش بس عدد المستخدمين)
// ?view=archived = الحسابات المؤرشفة بس، غير كده كل الحسابات ماعدا المؤرشفة
superAdminRouter.get("/tenants", async (req, res) => {
  const archived = req.query.view === "archived";
  const [tenants, paidByTenant, config] = await Promise.all([
    prisma.tenant.findMany({
    where: archived ? { accountStatus: "ARCHIVED" } : { accountStatus: { not: "ARCHIVED" } },
    include: {
      users: { orderBy: { createdAt: "asc" } },
      branches: true,
      _count: {
        select: {
          users: true,
          branches: true,
          bookings: true,
          walletCustomers: true,
          catalogOrders: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    }),
    // دفع حقيقي (PAID / ACTIVATED) - عشان نفرّق الحساب الحقيقي من التجريبي
    prisma.subscriptionOrder.groupBy({
      by: ["tenantId"],
      where: { status: { in: ["PAID", "ACTIVATED"] } },
      _count: { _all: true },
      _sum: { amount: true, amountUsd: true },
    }),
    getPlatformConfig(),
  ]);
  const paid = new Map(paidByTenant.map((g: any) => [g.tenantId, { count: g._count._all, total: Number(g._sum.amountUsd ?? g._sum.amount ?? 0) }]));
  const now = new Date();

  const result = tenants.map((t: any) => {
    const graceDays = t.graceDays ?? config.defaultGraceDays;
    return {
    id: t.id,
    name: t.name,
    industry: t.industry,
    currency: t.currency,
    slug: t.slug,
    subscribedModules: t.subscribedModules,
    moduleExpirations: t.moduleExpirations,
    createdAt: t.createdAt,
    owner: t.users.find((u: any) => u.role === "OWNER")
      ? { name: t.users.find((u: any) => u.role === "OWNER").name, email: t.users.find((u: any) => u.role === "OWNER").email }
      : null,
    users: t.users.map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive })),
    userCount: t._count.users,
    branchCount: t._count.branches,
    usage: {
      bookings: t._count.bookings,
      walletCustomers: t._count.walletCustomers,
      catalogOrders: t._count.catalogOrders,
    },
    accountStatus: t.accountStatus,
    statusReason: t.statusReason,
    statusChangedAt: t.statusChangedAt,
    graceDays: t.graceDays,
    effectiveGraceDays: graceDays,
    trialExpiresAt: t.trialExpiresAt,
    isPlatformOwner: t.isPlatformOwner,
    paidOrders: paid.get(t.id)?.count ?? 0,
    paidTotal: paid.get(t.id)?.total ?? 0,
    // حالة كل خدمة فعليًا: active / grace (خلصت ولسه في السماح) / expired / off
    moduleStatus: Object.fromEntries(
      ALL_MODULES.map((m) => {
        const on = t.isPlatformOwner || t.subscribedModules.includes(m);
        if (!on) return [m, "off"];
        if (isInGrace(t, m, now, graceDays)) return [m, "grace"];
        return [m, isModuleActive({ ...t, accountStatus: "ACTIVE" }, m, now, graceDays) ? "active" : "expired"];
      })
    ),
    };
  });

  res.json(result);
});

// إيقاف / تشغيل / أرشفة / استرجاع حساب. الإيقاف بيقفل الدخول (حتى الجلسات
// المفتوحة خلال ثواني) والصفحات العامة، والداتا كلها بتفضل محفوظة
const statusSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
  reason: z.string().trim().max(200).optional(),
});
async function setTenantStatus(ids: string[], status: (typeof ACCOUNT_STATUSES)[number], reason?: string) {
  // شركات صاحب المنصة (bluefield) ماتتوقفش أبدًا
  const result = await prisma.tenant.updateMany({
    where: { id: { in: ids }, isPlatformOwner: false },
    data: { accountStatus: status, statusReason: status === "ACTIVE" ? null : reason || null, statusChangedAt: new Date() },
  });
  clearAccessCache();
  return result.count;
}

superAdminRouter.patch("/tenants/:id/status", async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose ACTIVE, SUSPENDED or ARCHIVED" });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  if (tenant.isPlatformOwner) return res.status(400).json({ error: "The platform owner account can't be paused or archived." });
  await setTenantStatus([tenant.id], parsed.data.status, parsed.data.reason);
  res.json({ ok: true, status: parsed.data.status });
});

// أكتر من حساب مرة واحدة (مثلًا أرشفة كل الحسابات التجريبية)
const bulkStatusSchema = statusSchema.extend({ ids: z.array(z.string().uuid()).min(1).max(500) });
superAdminRouter.post("/tenants/bulk-status", async (req, res) => {
  const parsed = bulkStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick at least one company and a status" });
  const updated = await setTenantStatus(parsed.data.ids, parsed.data.status, parsed.data.reason);
  res.json({ ok: true, updated });
});

// أيام السماح لشركة معيّنة (null = الافتراضي بتاع المنصة)
const graceSchema = z.object({ graceDays: z.number().int().min(0).max(365).nullable() });
superAdminRouter.patch("/tenants/:id/grace", async (req, res) => {
  const parsed = graceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Grace days must be 0 – 365 (or empty for the default)" });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  await prisma.tenant.update({ where: { id: tenant.id }, data: { graceDays: parsed.data.graceDays } });
  res.json({ ok: true, graceDays: parsed.data.graceDays });
});

// تاريخ انتهاء خدمة لشركة: تاريخ معيّن، أو null = من غير انتهاء. بيشغّل
// الخدمة لو كانت مقفولة
const expirySchema = z.object({ expiresAt: z.string().datetime().nullable() });
superAdminRouter.patch("/tenants/:id/modules/:module/expiry", async (req, res) => {
  const moduleId = req.params.module;
  if (!(ALL_MODULES as readonly string[]).includes(moduleId)) return res.status(400).json({ error: "Unknown service" });
  const parsed = expirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick a valid date (or no expiry)" });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  const expirations = { ...((tenant.moduleExpirations as Record<string, string>) ?? {}) };
  if (parsed.data.expiresAt) expirations[moduleId] = new Date(parsed.data.expiresAt).toISOString();
  else delete expirations[moduleId];
  const subscribedModules = Array.from(new Set([...tenant.subscribedModules, moduleId]));
  const updated = await prisma.tenant.update({ where: { id: tenant.id }, data: { subscribedModules, moduleExpirations: expirations } });
  res.json({ subscribedModules: updated.subscribedModules, moduleExpirations: updated.moduleExpirations });
});

// أسعار الخدمات + أيام السماح الافتراضية (بتطبق على الطلبات الجديدة بس -
// الاشتراكات اللي اتدفعت خلاص مش بتتغيّر)
superAdminRouter.get("/platform-config", async (_req, res) => {
  const config = await getPlatformConfig();
  res.json({ ...config, defaults: { modulePrices: MODULE_PRICES } });
});

const platformConfigSchema = z.object({
  modulePrices: z.record(z.enum(ALL_MODULES), z.number().min(0).max(100000)).optional(),
  extraCompanyBasePrice: z.number().min(0).max(100000).optional(),
  yearlyDiscountPct: z.number().int().min(0).max(90).optional(),
  defaultGraceDays: z.number().int().min(0).max(365).optional(),
  // قواعد الخصم (اللستة كلها بتتبعت مرة واحدة): خدمات (فاضية = الكل) + نسبة +
  // شهري/سنوي/الاتنين + دول (فاضية = كل الدول) + تاريخ انتهاء. الشكل القديم
  // { erp: { pct, endsAt } } لسه مقبول (خصم لخدمة على الشهري والسنوي لكل الدول)
  discounts: z
    .union([
      z
        .array(
          z.object({
            id: z.string().max(40).optional(),
            modules: z.array(z.enum(ALL_MODULES)).max(10).default([]),
            pct: z.number().min(0).max(90),
            endsAt: z.string().datetime().nullable().optional(),
            cycle: z.enum(["both", "monthly", "yearly"]).default("both"),
            countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(250).default([]),
          })
        )
        .max(50),
      z.record(z.enum(ALL_MODULES), z.object({ pct: z.number().min(0).max(90), endsAt: z.string().datetime().nullable().optional() })),
    ])
    .optional(),
  // أسعار كل دولة بعملتها (الجدول كله بيتبعت مرة واحدة)
  regions: z
    .array(
      z.object({
        country: z.string().regex(/^[A-Za-z]{2}$/),
        name: z.string().trim().min(1).max(60),
        currency: z.string().refine(isCurrencyCode, "Unknown currency"),
        modulePrices: z.record(z.enum(ALL_MODULES), z.number().min(0).max(10000000).nullable()).default({}),
        extraCompanyBasePrice: z.number().min(0).max(10000000).nullable().optional(),
        yearlyDiscountPct: z.number().min(0).max(90).nullable().optional(),
      })
    )
    .max(50)
    .optional(),
});
superAdminRouter.patch("/platform-config", async (req, res) => {
  const parsed = platformConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Prices must be 0 or more, discount 0 – 90%, grace 0 – 365 days, each country a 2-letter code with a known currency" });
  const d = parsed.data;
  const current = await getPlatformConfig();
  await prisma.platformSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });
  await prisma.platformSettings.update({
    where: { id: "singleton" },
    data: {
      ...(d.modulePrices ? { modulePrices: { ...current.pricing.modulePrices, ...d.modulePrices } } : {}),
      ...(d.extraCompanyBasePrice !== undefined ? { extraCompanyBasePrice: d.extraCompanyBasePrice } : {}),
      ...(d.yearlyDiscountPct !== undefined ? { yearlyDiscountPct: d.yearlyDiscountPct } : {}),
      ...(d.defaultGraceDays !== undefined ? { defaultGraceDays: d.defaultGraceDays } : {}),
      ...(d.discounts
        ? {
            moduleDiscounts: (Array.isArray(d.discounts)
              ? d.discounts.map((r, i) => ({ ...r, id: r.id || `rule-${Date.now()}-${i}` }))
              : // الشكل القديم: بيعدّل قواعد الخدمات دي بس ويسيب الباقي
                [
                  ...current.discounts.filter((r) => !(r.modules.length === 1 && r.modules[0] in (d.discounts as object))),
                  ...Object.entries(d.discounts).map(([k, v]) => ({ id: `legacy-${k}`, modules: [k], pct: v.pct, endsAt: v.endsAt ?? null, cycle: "both" as const, countries: [] as string[] })),
                ]
            )
              .filter((r) => r.pct > 0)
              .map((r) => ({ id: r.id, modules: r.modules, pct: r.pct, endsAt: r.endsAt ?? null, cycle: r.cycle, countries: r.countries.map((c) => c.toUpperCase()) })),
          }
        : {}),
      ...(d.regions
        ? {
            pricingRegions: d.regions.map((r) => ({
              country: r.country.toUpperCase(),
              name: r.name,
              currency: r.currency,
              modulePrices: Object.fromEntries(Object.entries(r.modulePrices).filter(([, v]) => v != null)),
              extraCompanyBasePrice: r.extraCompanyBasePrice ?? null,
              yearlyDiscountPct: r.yearlyDiscountPct ?? null,
            })),
          }
        : {}),
    },
  });
  clearPlatformConfigCache();
  res.json(await getPlatformConfig());
});

const updateUserActiveSchema = z.object({ isActive: z.boolean() });

// تفعيل/تعطيل أي مستخدم في أي شركة - مفيد لو حساب فيه مشكلة أو محتاج توقيف
superAdminRouter.patch("/users/:id/active", async (req, res) => {
  const parsed = updateUserActiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const updated = await prisma.user.update({ where: { id: user.id }, data: { isActive: parsed.data.isActive } });
  clearAccessCache();
  res.json({ id: updated.id, isActive: updated.isActive });
});
const updateModulesSchema = z.object({
  subscribedModules: z.array(z.enum(["erp", "booking", "wallet", "whatsapp", "catalog", "linktree"])),
});

// تعديل الموديولات المشترك فيها شركة معيّنة
superAdminRouter.patch("/tenants/:id/modules", async (req, res) => {
  const parsed = updateModulesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // خدمة اتقفلت = صلاحيتها اتسحبت وتاريخها اتمسح (لو اتفتحت تاني ماترجعش
  // بتاريخ قديم منتهي). خدمة اتفتحت وتاريخها القديم فات = من غير انتهاء لحد
  // ما السوبر أدمن يحدد تاريخ
  const expirations = { ...((tenant.moduleExpirations as Record<string, string>) ?? {}) };
  const now = new Date();
  for (const m of Object.keys(expirations)) {
    const on = parsed.data.subscribedModules.includes(m as any);
    if (!on) delete expirations[m];
    else if (!tenant.subscribedModules.includes(m) && moduleExpiry(tenant, m)! <= now) delete expirations[m];
  }
  const updated = await prisma.tenant.update({
    where: { id: req.params.id },
    data: { subscribedModules: parsed.data.subscribedModules, moduleExpirations: expirations },
  });
  res.json(updated);
});

// رسائل "Let's Talk Business" الحقيقية اللي بعتها زوار الموقع من صفحة Contact
superAdminRouter.get("/contact-messages", async (_req, res) => {
  const messages = await prisma.contactMessage.findMany({ orderBy: { createdAt: "desc" } });
  res.json(messages);
});

// كل طلبات الاشتراك الحقيقية - عشان السوبر أدمن يراجعها ويفعّل الخدمات
// بعد ما يتأكد إن الدفع اتم فعليًا
// فلاتر: from / to (YYYY-MM-DD، شاملين اليوم كله)، status، tenantId، q (اسم الشركة / رقم الفاتورة)
function ordersWhere(q: Record<string, unknown>) {
  const where: any = {};
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : null);
  const from = day(q.from);
  const to = day(q.to);
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86400000) } : {}) };
  if (typeof q.status === "string" && ["PENDING", "PAID", "ACTIVATED", "CANCELLED"].includes(q.status)) where.status = q.status;
  if (typeof q.tenantId === "string" && q.tenantId) where.tenantId = q.tenantId;
  if (typeof q.q === "string" && q.q.trim()) {
    const term = q.q.trim();
    where.OR = [
      { tenant: { name: { contains: term, mode: "insensitive" } } },
      { id: { startsWith: term } },
      { myFatoorahInvoiceId: { contains: term } },
      { extraCompanyName: { contains: term, mode: "insensitive" } },
    ];
  }
  return where;
}

superAdminRouter.get("/orders", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: ordersWhere(req.query as Record<string, unknown>),
    include: { tenant: { select: { name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

// نفس الفلاتر كملف Excel (CSV)
superAdminRouter.get("/orders/export.csv", async (req, res) => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: ordersWhere(req.query as Record<string, unknown>),
    include: { tenant: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const cell = (v: unknown) => {
    const t = String(v ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [
    ["Date", "Invoice", "Client", "Type", "Items", "Billing", "Amount", "Currency", "Amount (USD)", "Status", "MyFatoorah #"],
    ...orders.map((o: any) => [
      o.createdAt.toISOString().slice(0, 10),
      o.id.slice(0, 8).toUpperCase(),
      o.tenant?.name ?? "",
      o.orderType === "EXTRA_COMPANY" ? "Extra company" : "Services",
      o.orderType === "EXTRA_COMPANY" ? `${o.extraCompanyName ?? ""} (${o.selectedModules.join(" + ")})` : o.selectedModules.join(" + "),
      o.billingCycle,
      Number(o.amount).toFixed(2),
      o.currency,
      Number(o.amountUsd ?? o.amount).toFixed(2),
      o.status,
      o.myFatoorahInvoiceId ?? "",
    ]),
  ];
  // BOM عشان Excel يفتح العربي صح
  const csv = "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="bluefield-invoices-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// تفعيل طلب اشتراك - بيضيف الخدمات المطلوبة لقائمة اشتراكات الشركة
// فعليًا، وميحصلش أوتوماتيك حتى لو الدفع نجح، السوبر أدمن لازم يدوسه بنفسه
// "Check payment": نسأل MyFatoorah عن فاتورة الطلب دلوقتي - لو اتدفعت بتتفعّل
superAdminRouter.post("/orders/:id/check-payment", async (req, res) => {
  try {
    const r = await syncOrderPayment(req.params.id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

superAdminRouter.post("/orders/:id/activate", async (req, res) => {
  // نفس منطق التفعيل الأوتوماتيك بعد الدفع (checkout/order-activation.ts)
  try {
    const result = await activateSubscriptionOrder(req.params.id);
    if ("alreadyActive" in result && result.alreadyActive) return res.status(400).json({ error: "This order is already activated" });
    res.json(result);
  } catch (err: any) {
    res.status(err.message === "Order not found" ? 404 : 400).json({ error: err.message });
  }
});

// تنزيل فاتورة PDF لطلب واحد - للسوبر أدمن بس، ده مش متاح للعميل
// نفسه؛ البيانات بتتولد لحظة الطلب من الـ SubscriptionOrder الحقيقي
// من غير أي تخزين لملفات على السيرفر
superAdminRouter.get("/orders/:id/invoice", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({
    where: { id: req.params.id },
    include: { tenant: { select: { name: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const pdfBuffer = await buildInvoicePdf(order, order.tenant.name);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="invoice-${order.id}.pdf"`);
  res.send(pdfBuffer);
});

superAdminRouter.post("/orders/:id/cancel", async (req, res) => {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const updated = await prisma.subscriptionOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  res.json(updated);
});

// --- Agency Staff (موظفين BlueField اللي بيديروا حسابات عملاء نيابةً عنهم) ---

superAdminRouter.get("/agency-staff", async (_req, res) => {
  const staff = await prisma.user.findMany({
    where: { isAgencyStaff: true },
    include: { agencyAssignments: { include: { clientTenant: { select: { id: true, name: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(
    staff.map((s: (typeof staff)[number]) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      isActive: s.isActive,
      assignedClients: s.agencyAssignments.map((a: (typeof s.agencyAssignments)[number]) => ({
        tenantId: a.clientTenant.id,
        name: a.clientTenant.name,
      })),
    }))
  );
});

const createAgencyStaffSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

// --- حسابات العملاء ---

const createClientSchema = z.object({
  companyName: z.string().trim().min(2, "Company name is too short").max(120),
  industry: z.enum(["RETAIL", "SERVICES", "HOSPITALITY", "REAL_ESTATE", "SALONS"]),
  ownerName: z.string().trim().min(2, "Owner name is too short").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  // فاضي = السيستم بيعمل باسورد مؤقت
  password: z.string().min(8, "The password must be at least 8 characters").max(200).optional().or(z.literal("")),
  sendEmail: z.boolean().default(true),
});

// السوبر أدمن بيعمل حساب لعميل: شركة + صاحبها (OWNER) بإيميل وباسورد، والبيانات
// بتتبعت للعميل على إيميله (لينك الدخول + الباسورد المؤقت + لينك يختار باسورد بنفسه)
superAdminRouter.post("/clients", async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (await emailTaken(d.email)) return res.status(400).json({ error: "This email already has a BlueField account" });
  const password = d.password || generateTempPassword();
  const tenant = await prisma.tenant.create({
    data: {
      name: d.companyName,
      industry: d.industry,
      slug: await generateUniqueSlug(d.companyName),
      // نفس تجربة التسجيل العادي (٢٤ ساعة) - الاشتراك بيتفعّل من السوبر أدمن
      trialExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      users: { create: { name: d.ownerName, email: d.email, passwordHash: await bcrypt.hash(password, 10), role: "OWNER" } },
    },
    include: { users: true },
  });
  const owner = tenant.users[0];
  let emailSent = false;
  if (d.sendEmail) {
    const link = await createPasswordLink(owner.id, "INVITE");
    emailSent = (await sendWelcomeEmail({ to: owner.email, name: owner.name, companyName: tenant.name, tempPassword: password, setPasswordLink: link })).ok;
  }
  // الباسورد بيرجع مرة واحدة بس (لو الإيميل ماوصلش، السوبر أدمن يبعته بنفسه)
  res.status(201).json({ tenantId: tenant.id, companyName: tenant.name, email: owner.email, password, emailSent });
});

const changeOwnerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  name: z.string().trim().min(2).max(80).optional(),
  // "edit" = نفس الشخص بإيميل جديد، "transfer" = صاحب تاني (الصاحب القديم بيبقى ADMIN)
  mode: z.enum(["edit", "transfer"]).default("edit"),
});

superAdminRouter.patch("/tenants/:id/owner", async (req, res) => {
  const parsed = changeOwnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, include: { users: { where: { role: "OWNER", isLinkedCompany: false } } } });
  if (!tenant) return res.status(404).json({ error: "Company not found" });
  const owner = tenant.users[0] ?? null;

  if (parsed.data.mode === "transfer" || !owner) {
    const r = await transferOwnership(tenant.id, owner?.id ?? null, parsed.data.email, parsed.data.name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    return res.json(r);
  }
  // نفس الصاحب، إيميل جديد: بنقفل جلساته ونبعتله لينك يختار باسورد على الإيميل الجديد
  if (parsed.data.email === owner.email.toLowerCase()) return res.status(400).json({ error: "That's already the owner's email" });
  if (await emailTaken(parsed.data.email, owner.id)) return res.status(400).json({ error: "This email already has a BlueField account" });
  const oldEmail = owner.email;
  await prisma.$transaction([
    prisma.user.update({ where: { id: owner.id }, data: { email: parsed.data.email, googleId: null, ...(parsed.data.name ? { name: parsed.data.name } : {}) } }),
    prisma.refreshToken.deleteMany({ where: { userId: owner.id } }),
  ]);
  const link = await createPasswordLink(owner.id, "INVITE");
  const sent = await sendOwnerInviteEmail({ to: parsed.data.email, name: parsed.data.name || owner.name, companyName: tenant.name, setPasswordLink: link });
  await sendEmailChangedNotice(oldEmail, owner.name, parsed.data.email).catch(() => {});
  res.json({ ok: true, ownerEmail: parsed.data.email, emailSent: sent.ok, newAccount: false });
});

superAdminRouter.post("/agency-staff", async (req, res) => {
  const parsed = createAgencyStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.user.findFirst({ where: { email: parsed.data.email } });
  if (existing) return res.status(400).json({ error: "Email already in use" });

  const homeTenant = await getOrCreateAgencyHomeTenant();
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  const staff = await prisma.user.create({
    data: {
      tenantId: homeTenant.id,
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash,
      role: "STAFF",
      isAgencyStaff: true,
    },
  });

  res.status(201).json({ id: staff.id, name: staff.name, email: staff.email, isActive: staff.isActive, assignedClients: [] });
});

const assignClientSchema = z.object({ tenantId: z.string().uuid() });

superAdminRouter.post("/agency-staff/:id/assign", async (req, res) => {
  const parsed = assignClientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const staff = await prisma.user.findFirst({ where: { id: req.params.id, isAgencyStaff: true } });
  if (!staff) return res.status(404).json({ error: "Agency staff member not found" });

  const tenant = await prisma.tenant.findUnique({ where: { id: parsed.data.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Client company not found" });

  await prisma.agencyAssignment.upsert({
    where: { staffUserId_clientTenantId: { staffUserId: staff.id, clientTenantId: tenant.id } },
    create: { staffUserId: staff.id, clientTenantId: tenant.id },
    update: {},
  });

  res.status(201).json({ ok: true });
});

superAdminRouter.delete("/agency-staff/:id/assign/:tenantId", async (req, res) => {
  await prisma.agencyAssignment.deleteMany({
    where: { staffUserId: req.params.id, clientTenantId: req.params.tenantId },
  });
  res.json({ ok: true });
});
