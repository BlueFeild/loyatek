import { Router } from "express";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";

// /api/whatsapp/inbox-tools - ردود جاهزة + توزيع المحادثات + رسالة برّه المواعيد (المنطق في InboxToolsService)
export const inboxToolsRouter = Router();

const editors = requireRole("OWNER", "ADMIN", "MANAGER");

inboxToolsRouter.get("/quick-replies", async (req, res) => {
  res.json(await container.inboxTools.listQuickReplies(req.auth!.tenantId));
});
inboxToolsRouter.post("/quick-replies", editors, async (req, res) => {
  res.status(201).json(await container.inboxTools.createQuickReply(req.auth!.tenantId, req.body));
});
inboxToolsRouter.patch("/quick-replies/:id", editors, async (req, res) => {
  res.json(await container.inboxTools.updateQuickReply(req.auth!.tenantId, req.params.id, req.body));
});
inboxToolsRouter.delete("/quick-replies/:id", editors, async (req, res) => {
  await container.inboxTools.deleteQuickReply(req.auth!.tenantId, req.params.id);
  res.json({ ok: true });
});

inboxToolsRouter.get("/settings", async (req, res) => {
  res.json(await container.inboxTools.getSettings(req.auth!.tenantId));
});
inboxToolsRouter.put("/settings", requireRole("OWNER", "ADMIN"), async (req, res) => {
  res.json(await container.inboxTools.saveSettings(req.auth!.tenantId, req.body));
});
