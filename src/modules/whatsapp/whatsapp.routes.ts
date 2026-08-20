import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { getOrCreateWhatsappSettings, getUnifiedContacts } from "./whatsapp.service";

export const whatsappRouter = Router();

whatsappRouter.use(requireAuth);

// --- Settings (مكان محجوز لمفاتيح Meta لما تتوصل) ---

whatsappRouter.get("/settings", async (req, res) => {
  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  // متبعتش الـ access token نفسه للفرونت إند حتى لو موجود - بس نقول هل متوصل ولا لأ
  res.json({ isConnected: settings.isConnected, hasPhoneNumberId: !!settings.metaPhoneNumberId });
});

const updateSettingsSchema = z.object({
  metaAccessToken: z.string().min(1).optional(),
  metaPhoneNumberId: z.string().min(1).optional(),
});

whatsappRouter.patch("/settings", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await getOrCreateWhatsappSettings(req.auth!.tenantId);
  const updated = await prisma.whatsappSettings.update({
    where: { tenantId: req.auth!.tenantId },
    data: { ...parsed.data, isConnected: !!(parsed.data.metaAccessToken && parsed.data.metaPhoneNumberId) },
  });
  res.json({ isConnected: updated.isConnected, hasPhoneNumberId: !!updated.metaPhoneNumberId });
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

// إرسال حملة حقيقي - محتاج حساب Meta متصل فعليًا، عشان كده بيرفض
// بصراحة لو مفيش اتصال حقيقي بدل ما يتظاهر إنه بعت حاجة
whatsappRouter.post("/campaigns/:id/send", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const settings = await getOrCreateWhatsappSettings(req.auth!.tenantId);
  if (!settings.isConnected) {
    return res.status(400).json({
      error: "Connect a real Meta WhatsApp Business API account in Settings before sending campaigns.",
    });
  }
  // لسه مفيش تكامل فعلي مع Meta API حتى لو الإعدادات متسجّلة
  res.status(501).json({ error: "Meta WhatsApp Business API integration is not implemented yet." });
});
