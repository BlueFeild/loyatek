import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { zodMessage } from "../../utils/validation";
import { WEBHOOK_EVENTS } from "./webhook-signing";

// لوحة "API & Webhooks" (صاحب الشركة / الأدمن بس) - الـ controller بيتأكد من البيانات بس
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth, requireRole("OWNER", "ADMIN"));

const { integrationsService } = container;

const keySchema = z.object({ name: z.string().trim().min(1, "Give the key a name").max(60) });
const webhookSchema = z.object({ url: z.string().trim().min(8).max(500), events: z.array(z.string()).min(1, "Choose at least one event").max(20) });
const webhookPatchSchema = z.object({ url: z.string().trim().min(8).max(500).optional(), events: z.array(z.string()).max(20).optional(), enabled: z.boolean().optional() });

integrationsRouter.get("/events", (_req, res) => {
  res.json({ events: WEBHOOK_EVENTS });
});

// ---------- مفاتيح API ----------
integrationsRouter.get("/keys", async (req, res) => {
  res.json(await integrationsService.listKeys(req.auth!.tenantId));
});

integrationsRouter.post("/keys", async (req, res) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await integrationsService.createKey(req.auth!.tenantId, req.auth!.userId, parsed.data.name));
});

integrationsRouter.delete("/keys/:id", async (req, res) => {
  res.json(await integrationsService.revokeKey(req.auth!.tenantId, req.params.id));
});

// ---------- Webhooks ----------
integrationsRouter.get("/webhooks", async (req, res) => {
  res.json(await integrationsService.listWebhooks(req.auth!.tenantId));
});

integrationsRouter.post("/webhooks", async (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await integrationsService.createWebhook(req.auth!.tenantId, parsed.data));
});

integrationsRouter.patch("/webhooks/:id", async (req, res) => {
  const parsed = webhookPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await integrationsService.updateWebhook(req.auth!.tenantId, req.params.id, parsed.data));
});

integrationsRouter.post("/webhooks/:id/test", async (req, res) => {
  res.json(await integrationsService.testWebhook(req.auth!.tenantId, req.params.id));
});

integrationsRouter.post("/webhooks/:id/secret", async (req, res) => {
  res.json(await integrationsService.rotateSecret(req.auth!.tenantId, req.params.id));
});

integrationsRouter.delete("/webhooks/:id", async (req, res) => {
  res.json(await integrationsService.deleteWebhook(req.auth!.tenantId, req.params.id));
});
