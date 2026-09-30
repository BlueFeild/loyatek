import { Router } from "express";
import { z } from "zod";
import * as XLSX from "xlsx";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getOrCreateWhatsappSettings, getUnifiedContacts, sendWhatsappTestMessage, uploadWhatsappAudio, sendWhatsappAudioMessage, createWhatsappTemplate, getWhatsappTemplateStatus, uploadTemplateHeaderImage } from "./whatsapp.service";

export const whatsappRouter = Router();

whatsappRouter.use(requireAuth);

// --- Settings (مكان محجوز لمفاتيح Meta لما تتوصل) ---

whatsappRouter.get("/settings", async (req, res) => {
  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  // متبعتش الـ access token نفسه للفرونت إند حتى لو موجود - بس نقول هل متوصل ولا لأ
  res.json({ isConnected: settings.isConnected, hasPhoneNumberId: !!settings.metaPhoneNumberId, hasWabaId: !!settings.metaWabaId, hasAppId: !!settings.metaAppId });
});

const updateSettingsSchema = z.object({
  metaAccessToken: z.string().trim().min(1).optional(),
  metaPhoneNumberId: z.string().trim().min(1).optional(),
  metaWabaId: z.string().trim().min(1).optional(),
  metaAppId: z.string().trim().min(1).optional(),
});

whatsappRouter.patch("/settings", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateWhatsappSettings(req.auth!.tenantId);
  const updated = await prisma.whatsappSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: { ...parsed.data, isConnected: !!(parsed.data.metaAccessToken && parsed.data.metaPhoneNumberId) },
  });
  res.json({ isConnected: updated.isConnected, hasPhoneNumberId: !!updated.metaPhoneNumberId, hasWabaId: !!updated.metaWabaId, hasAppId: !!updated.metaAppId });
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
