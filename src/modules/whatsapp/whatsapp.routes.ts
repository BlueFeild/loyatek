import { Router, type Request } from "express";
import crypto from "crypto";
import { z } from "zod";
import * as XLSX from "xlsx";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { assertTenantOwns } from "../../utils/tenant-owned";
import {
  getOrCreateWhatsappSettings,
  getUnifiedContacts,
  sendWhatsappTestMessage,
  sendWhatsappTextMessage,
  uploadWhatsappAudio,
  sendWhatsappAudioMessage,
  createWhatsappTemplate,
  getWhatsappTemplateStatus,
  uploadTemplateHeaderImage,
  verifyWhatsappConnection,
  recordWhatsappMessage,
  sendWhatsappTemplate,
} from "./whatsapp.service";
import { HELLO_WORLD_ID, HELLO_WORLD_TEXT, listInboxTemplates, renderTemplateText, templateParamCount } from "./inbox-templates";
import { embeddedSignupConfig, exchangeSignupCode, findWabaPhoneNumber, registerPhoneNumber, subscribeAppToWaba } from "./embedded-signup";
import { BOOKING_TEMPLATE_PURPOSES, ensureBookingTemplates, getApprovedBookingTemplate, type BookingTemplatePurpose } from "./booking-templates";

export const whatsappRouter = Router();

whatsappRouter.use(requireAuth);

// --- Settings (ربط حساب Meta الحقيقي) ---

// لينك الـ webhook العام اللي التاجر بيحطه في تطبيقه على Meta
function apiBase(req: Request) {
  if (process.env.PUBLIC_API_BASE_URL) return process.env.PUBLIC_API_BASE_URL.replace(/\/+$/, "");
  const proto = (req.header("x-forwarded-proto") || req.protocol).split(",")[0].trim();
  return `${proto}://${req.get("host")}`;
}

// كل تاجر ليه لينك webhook سري + Verify Token (بيتعملوا أول مرة بس)
async function ensureWebhookKeys(tenantId: string) {
  const s = await getOrCreateWhatsappSettings(tenantId);
  if (s.webhookKey && s.webhookVerifyToken) return s;
  return prisma.whatsappSettings.update({
    where: { tenantId },
    data: { webhookKey: s.webhookKey ?? crypto.randomBytes(24).toString("hex"), webhookVerifyToken: s.webhookVerifyToken ?? crypto.randomBytes(16).toString("hex") },
  });
}

// مفيش أي سر بيرجع للفرونت إند (لا الـ token ولا الـ App Secret) - بس حالة الربط
function settingsView(s: Awaited<ReturnType<typeof getOrCreateWhatsappSettings>>, req: Request) {
  return {
    isConnected: s.isConnected,
    hasAccessToken: !!s.metaAccessToken,
    hasPhoneNumberId: !!s.metaPhoneNumberId,
    hasWabaId: !!s.metaWabaId,
    hasAppId: !!s.metaAppId,
    hasAppSecret: !!s.metaAppSecret,
    phoneNumberId: s.metaPhoneNumberId,
    wabaId: s.metaWabaId,
    appId: s.metaAppId,
    displayPhoneNumber: s.displayPhoneNumber,
    verifiedName: s.verifiedName,
    lastVerifiedAt: s.lastVerifiedAt,
    lastVerifyError: s.lastVerifyError,
    webhookUrl: s.webhookKey ? `${apiBase(req)}/api/public/whatsapp/webhook/${s.webhookKey}` : null,
    webhookVerifyToken: s.webhookVerifyToken,
    lastWebhookAt: s.lastWebhookAt,
    botEnabled: s.botEnabled,
    botFallbackReply: s.botFallbackReply,
  };
}

// تأكيد حقيقي من Meta وتحديث حالة الربط
async function runVerify(tenantId: string) {
  const s = await getOrCreateWhatsappSettings(tenantId);
  if (!s.metaAccessToken || !s.metaPhoneNumberId) {
    return prisma.whatsappSettings.update({ where: { tenantId }, data: { isConnected: false, lastVerifyError: "Add the access token and phone number ID first." } });
  }
  const v = await verifyWhatsappConnection(s.metaAccessToken, s.metaPhoneNumberId, s.metaWabaId);
  return prisma.whatsappSettings.update({
    where: { tenantId },
    data: v.ok
      ? { isConnected: true, displayPhoneNumber: v.displayPhoneNumber ?? null, verifiedName: v.verifiedName ?? null, lastVerifiedAt: new Date(), lastVerifyError: null }
      : { isConnected: false, lastVerifyError: v.error ?? "Meta rejected the connection" },
  });
}

whatsappRouter.get("/settings", async (req, res) => {
  const settings = await ensureWebhookKeys(req.auth!.tenantId);
  res.json(settingsView(settings, req));
});

const updateSettingsSchema = z.object({
  metaAccessToken: z.string().trim().min(1).optional(),
  metaPhoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Phone number ID is a long number from Meta (not the phone itself)").optional(),
  metaWabaId: z.string().trim().regex(/^\d{5,30}$/, "WABA ID is a long number from Meta").optional(),
  metaAppId: z.string().trim().regex(/^\d{5,30}$/, "App ID is a long number from Meta").optional(),
  metaAppSecret: z.string().trim().regex(/^[a-f0-9]{16,64}$/i, "App Secret looks wrong — copy it from Meta App → Settings → Basic").optional(),
  botEnabled: z.boolean().optional(),
  botFallbackReply: z.string().max(1000).optional(),
});

// الحفظ بيدمج مع القديم (حقل مش مبعوت = بيفضل زي ما هو)، وبعد تغيير بيانات
// الربط بنسأل Meta فورًا هل هي صح
whatsappRouter.patch("/settings", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" });

  await ensureWebhookKeys(req.auth!.tenantId);
  await prisma.whatsappSettings.update({ where: { tenantId: req.auth!.tenantId }, data: parsed.data });
  const touchedCredentials = ["metaAccessToken", "metaPhoneNumberId", "metaWabaId"].some((k) => k in parsed.data);
  const updated = touchedCredentials ? await runVerify(req.auth!.tenantId) : await getOrCreateWhatsappSettings(req.auth!.tenantId);
  res.json(settingsView(updated, req));
});

// فك ربط رقم الواتساب: بيشيل المفتاح والرقم من الشركة (المنصة تبطّل تبعت أو تستقبل عليه).
// المحادثات والقوالب والبوت بيفضلوا محفوظين، ويتربط رقم تاني وقت ما تحبي
whatsappRouter.post("/disconnect", requireRole("OWNER", "ADMIN"), async (req, res) => {
  await getOrCreateWhatsappSettings(req.auth!.tenantId);
  await prisma.whatsappSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: {
      metaAccessToken: null,
      metaPhoneNumberId: null,
      metaWabaId: null,
      isConnected: false,
      displayPhoneNumber: null,
      verifiedName: null,
      lastVerifiedAt: null,
      lastVerifyError: null,
    },
  });
  res.json(settingsView(await getOrCreateWhatsappSettings(req.auth!.tenantId), req));
});

// --- Embedded Signup (ربط الواتساب من نافذة Meta من غير نسخ IDs وتوكن) ---

// القيم العامة اللي الصفحة محتاجاها عشان تفتح نافذة Meta (من غير أي سر)
whatsappRouter.get("/embedded-signup/config", (_req, res) => {
  res.json(embeddedSignupConfig());
});

const embeddedCompleteSchema = z.object({
  code: z.string().trim().min(10).max(2000),
  wabaId: z.string().trim().regex(/^\d{5,30}$/, "Meta didn't send a valid WhatsApp Business Account ID"),
  // في ربط تطبيق الموبايل ممكن يجي فاضي - بنجيبه من Meta
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "Meta didn't send a valid phone number ID").optional(),
  // الرقم شغال على تطبيق واتساب Business وهيفضل شغال عليه (Coexistence)
  coexistence: z.boolean().optional(),
});

// بعد ما التاجر يخلص في نافذة Meta: نبدّل الكود بتوكن، نشترك في رسايل الحساب،
// نفعّل الرقم، ونحفظ ونتأكد من الربط - كل ده من غير ما التاجر ينسخ حاجة
whatsappRouter.post("/embedded-signup/complete", requireRole("OWNER", "ADMIN"), async (req, res) => {
  if (!embeddedSignupConfig().enabled) return res.status(400).json({ error: "Connecting with Facebook isn't set up yet — use the manual setup below." });
  const parsed = embeddedCompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data from Meta" });
  const { code, wabaId, coexistence } = parsed.data;
  let phoneNumberId = parsed.data.phoneNumberId;
  const tenantId = req.auth!.tenantId;

  const exchanged = await exchangeSignupCode(code);
  if (!exchanged.ok || !exchanged.token) return res.status(400).json({ error: `Meta didn't accept the sign-in: ${exchanged.error}` });
  const token = exchanged.token;
  if (!phoneNumberId) {
    const found = await findWabaPhoneNumber(token, wabaId);
    if (!found.ok || !found.phoneNumberId) return res.status(400).json({ error: found.error ?? "Meta didn't send the phone number" });
    phoneNumberId = found.phoneNumberId;
  }

  const warnings: string[] = [];
  const sub = await subscribeAppToWaba(token, wabaId);
  if (!sub.ok) warnings.push(`Incoming messages: ${sub.error}`);
  // في Coexistence الرقم متسجّل على التطبيق - التفعيل (register) كان هيفصله من الموبايل
  if (!coexistence) {
    const reg = await registerPhoneNumber(token, phoneNumberId);
    if (!reg.ok && !/already|registered/i.test(reg.error ?? "")) warnings.push(`Number activation: ${reg.error}`);
  }

  await ensureWebhookKeys(tenantId);
  await prisma.whatsappSettings.update({
    where: { tenantId },
    data: { metaAccessToken: token, metaPhoneNumberId: phoneNumberId, metaWabaId: wabaId, metaAppId: process.env.META_APP_ID?.trim() || null },
  });
  const updated = await runVerify(tenantId);
  if (!updated.isConnected) return res.status(400).json({ error: updated.lastVerifyError ?? "Meta rejected the connection", warnings });
  res.json({ ...settingsView(updated, req), warnings });
});

// تفعيل الرقم على Cloud API (register) - مطلوب مرة واحدة للرقم الحقيقي اللي
// اتضاف من لوحة Meta. الـ PIN = التحقق بخطوتين للرقم (6 أرقام)
const registerSchema = z.object({ pin: z.string().regex(/^\d{6}$/, "The PIN must be exactly 6 digits") });
whatsappRouter.post("/register-number", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid PIN" });
  const s = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!s.metaAccessToken || !s.metaPhoneNumberId) return res.status(400).json({ error: "Save the access token and phone number ID first." });
  const r = await registerPhoneNumber(s.metaAccessToken, s.metaPhoneNumberId, parsed.data.pin);
  if (!r.ok) return res.status(400).json({ error: `Meta says: ${r.error}` });
  const updated = await runVerify(req.auth!.tenantId);
  res.json(settingsView(updated, req));
});

whatsappRouter.post("/verify", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  await ensureWebhookKeys(req.auth!.tenantId);
  const updated = await runVerify(req.auth!.tenantId);
  res.json(settingsView(updated, req));
});

// رسالة تجربة لأي رقم: من غير نص = قالب hello_world المعتمد من Meta (بيوصل
// دايمًا)، بنص = رسالة حرة (بتوصل بس لو الرقم ده كلّم البيزنس آخر 24 ساعة)
const testMessageSchema = z.object({
  to: z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, "Enter the number with country code, e.g. 97455551234"),
  text: z.string().trim().max(1000).optional(),
});

whatsappRouter.post("/test-message", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = testMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid number" });
  const s = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!s.metaAccessToken || !s.metaPhoneNumberId) return res.status(400).json({ error: "Connect WhatsApp first." });
  const to = parsed.data.to.replace(/[^\d]/g, "");
  const result = parsed.data.text
    ? await sendWhatsappTextMessage(s.metaAccessToken, s.metaPhoneNumberId, to, parsed.data.text)
    : await sendWhatsappTestMessage(s.metaAccessToken, s.metaPhoneNumberId, to);
  await recordWhatsappMessage({
    tenantId: req.auth!.tenantId,
    direction: "OUT",
    contactPhone: to,
    body: parsed.data.text || "hello_world (Meta test template)",
    kind: parsed.data.text ? "text" : "template",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, messageId: result.messageId });
});

// --- قوالب الحجز المعتمدة (تأكيد / إشعار التاجر / تذكير) ---

whatsappRouter.get("/booking-templates", async (req, res) => {
  const rows = await prisma.whatsappTemplate.findMany({ where: { tenantId: req.auth!.tenantId, purpose: { not: null } }, orderBy: { name: "asc" } });
  res.json(rows.map((t) => ({ id: t.id, name: t.name, language: t.language, purpose: t.purpose, status: t.status, rejectionReason: t.rejectionReason, bodyText: t.bodyText })));
});

whatsappRouter.post("/booking-templates", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const lang = req.body?.language === "ar" ? "ar" : "en";
  try {
    res.json({ results: await ensureBookingTemplates(req.auth!.tenantId, lang) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// تحديث حالة كل قوالب الحجز من Meta مرة واحدة
whatsappRouter.post("/booking-templates/refresh", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const rows = await prisma.whatsappTemplate.findMany({ where: { tenantId, purpose: { not: null }, status: "PENDING" } });
  for (const t of rows) {
    if (t.purpose && (BOOKING_TEMPLATE_PURPOSES as readonly string[]).includes(t.purpose)) {
      await getApprovedBookingTemplate(tenantId, t.purpose as BookingTemplatePurpose, t.language === "ar" ? "ar" : "en");
    }
  }
  const all = await prisma.whatsappTemplate.findMany({ where: { tenantId, purpose: { not: null } }, orderBy: { name: "asc" } });
  res.json(all.map((t) => ({ id: t.id, name: t.name, language: t.language, purpose: t.purpose, status: t.status, rejectionReason: t.rejectionReason, bodyText: t.bodyText })));
});

// --- البوت: ردود تلقائية بالكلمات المفتاحية ---

whatsappRouter.get("/auto-replies", async (req, res) => {
  res.json(await prisma.whatsappAutoReply.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { sortOrder: "asc" } }));
});

const autoReplySchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  reply: z.string().trim().min(1).max(1000),
  enabled: z.boolean().optional(),
});

whatsappRouter.post("/auto-replies", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = autoReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid auto-reply" });
  const count = await prisma.whatsappAutoReply.count({ where: { tenantId: req.auth!.tenantId } });
  const row = await prisma.whatsappAutoReply.create({ data: { tenantId: req.auth!.tenantId, ...parsed.data, sortOrder: count } });
  res.status(201).json(row);
});

whatsappRouter.patch("/auto-replies/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = autoReplySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid auto-reply" });
  const row = await prisma.whatsappAutoReply.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!row) return res.status(404).json({ error: "Auto-reply not found" });
  res.json(await prisma.whatsappAutoReply.update({ where: { id: row.id }, data: parsed.data }));
});

whatsappRouter.delete("/auto-replies/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const row = await prisma.whatsappAutoReply.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!row) return res.status(404).json({ error: "Auto-reply not found" });
  await prisma.whatsappAutoReply.delete({ where: { id: row.id } });
  res.json({ ok: true });
});

// --- المحادثات الحقيقية (من الـ webhook) ---

whatsappRouter.get("/conversations", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const recent = await prisma.whatsappMessage.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 500 });
  const byPhone = new Map<string, { phone: string; name: string | null; lastMessage: string; lastAt: Date; lastDirection: string; lastInAt: Date | null }>();
  for (const m of recent) {
    const c = byPhone.get(m.contactPhone);
    if (!c) {
      byPhone.set(m.contactPhone, { phone: m.contactPhone, name: m.contactName, lastMessage: m.body, lastAt: m.createdAt, lastDirection: m.direction, lastInAt: m.direction === "IN" ? m.createdAt : null });
    } else {
      if (!c.name && m.contactName) c.name = m.contactName;
      if (!c.lastInAt && m.direction === "IN") c.lastInAt = m.createdAt;
    }
  }
  res.json(Array.from(byPhone.values()));
});

whatsappRouter.get("/conversations/:phone/messages", async (req, res) => {
  const phone = req.params.phone.replace(/[^\d]/g, "");
  const rows = await prisma.whatsappMessage.findMany({ where: { tenantId: req.auth!.tenantId, contactPhone: phone }, orderBy: { createdAt: "asc" }, take: 300 });
  res.json(rows);
});

// رد من Team Inbox - نص حر (مسموح لأن العميل كلّمنا آخر 24 ساعة)
whatsappRouter.post("/conversations/:phone/reply", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 4000) return res.status(400).json({ error: "Write a message (up to 4000 characters)." });
  const s = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!s.isConnected || !s.metaAccessToken || !s.metaPhoneNumberId) return res.status(400).json({ error: "Connect WhatsApp first." });
  const phone = req.params.phone.replace(/[^\d]/g, "");
  const result = await sendWhatsappTextMessage(s.metaAccessToken, s.metaPhoneNumberId, phone, text);
  const row = await recordWhatsappMessage({
    tenantId: req.auth!.tenantId,
    direction: "OUT",
    contactPhone: phone,
    body: text,
    kind: "text",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
  if (!result.ok) return res.status(400).json({ error: result.error, message: row });
  res.json(row);
});

// --- قوالب من شاشة المحادثات: بعد الـ24 ساعة أو محادثة جديدة مع أي رقم ---

whatsappRouter.get("/inbox-templates", async (req, res) => {
  res.json(await listInboxTemplates(req.auth!.tenantId));
});

const inboxTemplateSchema = z.object({
  templateId: z.string().min(1),
  params: z.array(z.string().trim().max(500)).max(20).default([]),
  // اسم العميل (اختياري) - بيظهر في قايمة المحادثات بداله الرقم
  contactName: z.string().trim().max(120).optional(),
});

whatsappRouter.post("/conversations/:phone/template", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = inboxTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid template" });
  const phone = req.params.phone.replace(/[^\d]/g, "");
  if (phone.length < 7 || phone.length > 15) return res.status(400).json({ error: "Enter the number with country code, e.g. 97455551234" });
  const tenantId = req.auth!.tenantId;
  const s = await getOrCreateWhatsappSettings(tenantId);
  if (!s.isConnected || !s.metaAccessToken || !s.metaPhoneNumberId) return res.status(400).json({ error: "Connect WhatsApp first." });

  const d = parsed.data;
  let name = "hello_world", language = "en_US", body = HELLO_WORLD_TEXT, params: string[] = [];
  if (d.templateId !== HELLO_WORLD_ID) {
    // القالب لازم يكون تبع نفس الشركة ومعتمد من Meta
    const tpl = await prisma.whatsappTemplate.findFirst({ where: { id: d.templateId, tenantId } });
    if (!tpl) return res.status(404).json({ error: "Template not found" });
    if (tpl.status !== "APPROVED") return res.status(400).json({ error: `This template isn't approved by Meta yet (status: ${tpl.status}).` });
    if (tpl.headerImageDataUrl) return res.status(400).json({ error: "This template has a photo header — send it from Campaigns." });
    const count = templateParamCount(tpl.bodyText);
    params = Array.from({ length: count }, (_, i) => d.params[i] ?? "");
    if (params.some((v) => !v.trim())) return res.status(400).json({ error: `Fill in all ${count} blanks of the template.` });
    name = tpl.name;
    language = tpl.language;
    body = renderTemplateText(tpl.bodyText, params);
  }
  const result = await sendWhatsappTemplate(s.metaAccessToken, s.metaPhoneNumberId, phone, name, language, params);
  const row = await recordWhatsappMessage({
    tenantId,
    direction: "OUT",
    contactPhone: phone,
    contactName: d.contactName || null,
    body,
    kind: "template",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
  if (!result.ok) return res.status(400).json({ error: result.error, message: row });
  res.json(row);
});

// --- Bot Flow Builder ---

whatsappRouter.get("/flow-nodes", async (req, res) => {
  const nodes = await prisma.botFlowNode.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { sortOrder: "asc" },
  });
  res.json(nodes);
});

const createNodeSchema = z.object({
  type: z.enum(["trigger", "message", "delay", "webhook", "menu", "condition"]),
  badge: z.string().min(1),
  title: z.string().min(1),
  desc: z.string().min(1),
});

whatsappRouter.post("/flow-nodes", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createNodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const count = await prisma.botFlowNode.count({ where: { tenantId: req.auth!.tenantId } });
  const node = await prisma.botFlowNode.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data, sortOrder: count },
  });
  res.status(201).json(node);
});

whatsappRouter.delete("/flow-nodes/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const node = await prisma.botFlowNode.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!node) return res.status(404).json({ error: "Node not found" });

  await prisma.botFlowNode.delete({ where: { id: node.id } });
  res.json({ ok: true });
});

// --- Unified Contacts (مبنية من عملاء حقيقيين موجودين بالفعل) ---

whatsappRouter.get("/contacts", async (req, res) => {
  const contacts = await getUnifiedContacts(req.auth!.tenantId);
  res.json(contacts);
});

whatsappRouter.get("/contacts/:phone/notes", async (req, res) => {
  const notes = await prisma.whatsappContactNote.findMany({
    where: { tenantId: req.auth!.tenantId, phone: req.params.phone },
    orderBy: { createdAt: "desc" },
  });
  res.json(notes);
});

const addNoteSchema = z.object({ authorName: z.string().min(1), text: z.string().min(1) });

whatsappRouter.post("/contacts/:phone/notes", requireRole("OWNER", "ADMIN", "MANAGER", "STAFF"), async (req, res) => {
  const parsed = addNoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const note = await prisma.whatsappContactNote.create({
    data: { tenantId: req.auth!.tenantId, phone: req.params.phone, ...parsed.data },
  });
  res.status(201).json(note);
});

// --- Campaigns (مسودات حقيقية - الإرسال الفعلي محتاج تكامل Meta) ---

whatsappRouter.get("/campaigns", async (req, res) => {
  const campaigns = await prisma.whatsappCampaign.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(campaigns);
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
  segmentDesc: z.string().min(1),
  templateText: z.string().min(1),
  templateId: z.string().uuid().nullable().optional(),
});

whatsappRouter.post("/campaigns", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // القالب لازم يكون من قوالب نفس الشركة
  try {
    await assertTenantOwns(req.auth!.tenantId, { whatsappTemplateIds: [parsed.data.templateId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const campaign = await prisma.whatsappCampaign.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(campaign);
});

whatsappRouter.delete("/campaigns/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const campaign = await prisma.whatsappCampaign.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  await prisma.whatsappCampaign.delete({ where: { id: campaign.id } });
  res.json({ ok: true });
});

// حفظ حملة صوتية حقيقية - التسجيل جاي فعليًا من ميكروفون التاجر
// (مش محتوى جاهز من عندنا)، بيتحفظ base64 مؤقتًا لحد وقت الإرسال
const createVoiceCampaignSchema = z.object({
  name: z.string().min(1),
  audioBase64: z.string().min(1),
});

whatsappRouter.post("/campaigns/voice", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createVoiceCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const campaign = await prisma.whatsappCampaign.create({
    data: {
      tenantId: req.auth!.tenantId,
      name: parsed.data.name,
      kind: "VOICE",
      audioBase64: parsed.data.audioBase64,
      segmentDesc: "Voice broadcast",
      templateText: "",
    },
  });
  res.status(201).json(campaign);
});

// رفع ملف إكسل حقيقي وتحليله - بيدوّر على عمود اسمه Phone/رقم وعمود
// اسمه Name/اسم (بأي حروف كبيرة/صغيرة)، ولو ملقاش أعمدة بالاسم ده
// بياخد أول عمودين في الشيت. الأرقام دي هي اللي هتتبعتلها الحملة فعليًا
const uploadRecipientsSchema = z.object({
  fileBase64: z.string().min(1),
});

whatsappRouter.post("/campaigns/:id/recipients/upload", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = uploadRecipientsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const campaign = await prisma.whatsappCampaign.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  let rows: any[];
  try {
    const buffer = Buffer.from(parsed.data.fileBase64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
  } catch {
    return res.status(400).json({ error: "Couldn't read this file — please upload a valid Excel (.xlsx) file" });
  }

  if (rows.length === 0) return res.status(400).json({ error: "The file has no rows" });

  const keys = Object.keys(rows[0]);
  const phoneKey = keys.find((k) => /phone|رقم|number/i.test(k)) ?? keys[0];
  const nameKey = keys.find((k) => /name|اسم/i.test(k)) ?? keys[1];

  const recipients = rows
    .map((r: any) => ({ phone: String(r[phoneKey] ?? "").replace(/[^\d]/g, ""), name: String(r[nameKey] ?? "").trim() || "Customer" }))
    .filter((r: any) => r.phone.length >= 6);

  if (recipients.length === 0) {
    return res.status(400).json({ error: "No valid phone numbers found in the file" });
  }

  const updated = await prisma.whatsappCampaign.update({
    where: { id: campaign.id },
    data: { recipients, sentCount: 0, failedCount: 0, status: "DRAFT" },
  });
  res.json(updated);
});

// إرسال حملة حقيقي - محتاج حساب Meta متصل فعليًا، عشان كده بيرفض
// بصراحة لو مفيش اتصال حقيقي بدل ما يتظاهر إنه بعت حاجة. بيبعت لكل
// المستلمين الحقيقيين المرفوعين من الإكسل واحد واحد، ومش بيوقف لو
// واحد فيهم فشل - بيكمّل الباقي ويرجّع تقرير حقيقي بالنجاح والفشل
whatsappRouter.post("/campaigns/:id/send", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaPhoneNumberId) {
    return res.status(400).json({
      error: "Connect a real Meta WhatsApp Business API account in Settings before sending campaigns.",
    });
  }

  const campaign = await prisma.whatsappCampaign.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
    include: { template: true },
  });
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const recipients = campaign.recipients as { phone: string; name: string }[];
  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ error: "Upload a recipient list (Excel file) before sending this campaign." });
  }

  let sent = 0;
  let failed = 0;

  if (campaign.kind === "VOICE") {
    if (!campaign.audioBase64) return res.status(400).json({ error: "This voice campaign has no recording attached." });

    // الملف الصوتي بيترفع مرة واحدة بس لـ Meta، وبعدين نفس الـ media_id
    // بيتبعت لكل المستلمين - مش رفع منفصل لكل واحد
    const upload = await uploadWhatsappAudio(settings.metaAccessToken, settings.metaPhoneNumberId, campaign.audioBase64);
    if (!upload.ok || !upload.mediaId) {
      return res.status(400).json({ error: upload.error || "Failed to upload the voice recording to Meta" });
    }

    for (const r of recipients) {
      // ملحوظة مهمة: واتساب مايسمحش برسايل صوتية حرة إلا للأرقام اللي
      // بعتت رسالة للحساب خلال آخر 24 ساعة - ده قيد حقيقي من Meta،
      // فمتوقع إن بعض المستلمين يفشلوا لو مبعتوش رسالة لحسابك مؤخرًا
      const result = await sendWhatsappAudioMessage(settings.metaAccessToken, settings.metaPhoneNumberId, r.phone, upload.mediaId);
      if (result.ok) sent++;
      else failed++;
    }
  } else {
    // لو الحملة مرتبطة بقالب معتمد فعليًا من Meta، بنستخدمه بالاسم
    // واللغة الحقيقيين بتوعه. لو مفيش قالب مرتبط، أو القالب لسه PENDING
    // ومامتوفقش عليه، بنرجع لـ "hello_world" الافتراضي المعتمد تلقائيًا
    if (campaign.template && campaign.template.status !== "APPROVED") {
      return res.status(400).json({
        error: `This campaign's template "${campaign.template.name}" isn't approved by Meta yet (status: ${campaign.template.status}). Wait for approval or send without a custom template.`,
      });
    }
    const templateName = campaign.template?.status === "APPROVED" ? campaign.template.name : "hello_world";
    const templateLang = campaign.template?.status === "APPROVED" ? campaign.template.language : "en_US";

    for (const r of recipients) {
      // نداء حقيقي فعلي لكل رقم لـ Meta Graph API - مش محاكاة
      const result = await sendWhatsappTestMessage(settings.metaAccessToken, settings.metaPhoneNumberId, r.phone, templateName, templateLang);
      if (result.ok) sent++;
      else failed++;
    }
  }

  await prisma.whatsappCampaign.update({
    where: { id: campaign.id },
    data: { status: "SENT", sentCount: sent, failedCount: failed },
  });
  res.json({ ok: true, sent, failed, total: recipients.length });
});

// --- Message Templates (قوالب رسائل حقيقية بترفع لـ Meta للموافقة) ---

whatsappRouter.get("/templates", async (req, res) => {
  const templates = await prisma.whatsappTemplate.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(templates);
});

const createTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, "Template name must be lowercase letters, numbers, and underscores only"),
  language: z.string().default("ar"),
  category: z.enum(["MARKETING", "UTILITY"]).default("MARKETING"),
  bodyText: z.string().min(1).max(1024),
  buttonText: z.string().optional(),
  buttonUrl: z.string().url().optional(),
  headerImageBase64: z.string().optional(),
  headerImageMimeType: z.string().optional(),
});

// إنشاء ورفع قالب حقيقي لـ Meta فورًا - مش بيتخزن بس، بيتبعت فعليًا
// لمراجعة Meta زي أي قالب تسويقي حقيقي (زي مثال دومينوز). لو فيه
// صورة، بترفع الأول في نداء منفصل (نظام Meta مختلف تمامًا) قبل ما
// نستخدم الـ handle الناتج في إنشاء القالب نفسه
whatsappRouter.post("/templates", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaWabaId) {
    return res.status(400).json({
      error: "Connect a real Meta WhatsApp Business account with a WhatsApp Business Account ID (WABA ID) first.",
    });
  }

  let headerImageHandle: string | undefined;
  if (parsed.data.headerImageBase64) {
    if (!settings.metaAppId) {
      return res.status(400).json({ error: "Add your Meta App ID in settings first — it's required to upload a header image." });
    }
    const upload = await uploadTemplateHeaderImage(
      settings.metaAccessToken,
      settings.metaAppId,
      parsed.data.headerImageBase64,
      parsed.data.headerImageMimeType || "image/jpeg"
    );
    if (!upload.ok || !upload.handle) {
      return res.status(400).json({ error: upload.error || "Failed to upload the header image to Meta" });
    }
    headerImageHandle = upload.handle;
  }

  const result = await createWhatsappTemplate(settings.metaAccessToken, settings.metaWabaId, {
    name: parsed.data.name,
    language: parsed.data.language,
    category: parsed.data.category,
    bodyText: parsed.data.bodyText,
    buttonText: parsed.data.buttonText,
    buttonUrl: parsed.data.buttonUrl,
    headerImageHandle,
  });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const template = await prisma.whatsappTemplate.create({
    data: {
      tenantId: req.auth!.tenantId,
      settingsId: settings.id,
      name: parsed.data.name,
      language: parsed.data.language,
      category: parsed.data.category,
      bodyText: parsed.data.bodyText,
      buttonText: parsed.data.buttonText,
      buttonUrl: parsed.data.buttonUrl,
      headerImageDataUrl: parsed.data.headerImageBase64 ? `data:${parsed.data.headerImageMimeType};base64,${parsed.data.headerImageBase64}` : undefined,
      metaTemplateId: result.metaTemplateId,
      status: "PENDING",
    },
  });
  res.status(201).json(template);
});

// الاستعلام الحقيقي عن حالة القالب من عند Meta نفسها - Pending لحد
// ما فريق المراجعة بتاعهم يقرر، مش رقم بنقرره إحنا
whatsappRouter.post("/templates/:id/check-status", async (req, res) => {
  const template = await prisma.whatsappTemplate.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!template || !template.metaTemplateId) return res.status(404).json({ error: "Template not found" });

  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!settings.metaAccessToken) return res.status(400).json({ error: "WhatsApp account not connected" });

  const result = await getWhatsappTemplateStatus(settings.metaAccessToken, template.metaTemplateId);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const status = result.status === "APPROVED" ? "APPROVED" : result.status === "REJECTED" ? "REJECTED" : "PENDING";
  const updated = await prisma.whatsappTemplate.update({
    where: { id: template.id },
    data: { status, rejectionReason: result.rejectionReason },
  });
  res.json(updated);
});

whatsappRouter.delete("/templates/:id", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const template = await prisma.whatsappTemplate.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!template) return res.status(404).json({ error: "Template not found" });

  await prisma.whatsappTemplate.delete({ where: { id: template.id } });
  res.json({ ok: true });
});
