import { Router } from "express";
import { z } from "zod";
import { findTenantBySlug } from "./public-catalog.routes";
import { getOrCreateCatalogSettings } from "./catalog.service";
import { publicOrderStatus } from "./kitchen";

// صفحة "تابع طلبك" للعميل: /api/public/menu/:slug/orders/:id/status
// رقم الطلب (UUID) مش ممكن يتخمّن، والرد مافيهوش رقم الموبايل ولا روابط الدفع
export const publicOrderStatusRouter = Router();

publicOrderStatusRouter.get("/:slug/orders/:id/status", async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(404).json({ error: "Order not found" });
  const tenant = await findTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: "Menu not found" });
  const settings = await getOrCreateCatalogSettings(tenant.id);
  const status = await publicOrderStatus(tenant.id, req.params.id, settings.prepTime);
  if (!status) return res.status(404).json({ error: "Order not found" });
  res.setHeader("Cache-Control", "no-store");
  res.json(status);
});
