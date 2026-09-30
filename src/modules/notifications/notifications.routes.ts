import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { listNotifications, markNotificationRead, markAllNotificationsRead } from "./notifications.service";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const result = await listNotifications(req.auth!.tenantId, limit);
  res.json(result);
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  try {
    const notification = await markNotificationRead(req.auth!.tenantId, req.params.id);
    res.json(notification);
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : "Notification not found" });
  }
});

notificationsRouter.post("/read-all", async (req, res) => {
  const result = await markAllNotificationsRead(req.auth!.tenantId);
  res.json(result);
});
