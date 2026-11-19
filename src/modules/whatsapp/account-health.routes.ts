import { Router } from "express";
import { container } from "../../core/container";

// /api/whatsapp/health - صحة حساب الواتساب بكلام بسيط (المنطق في AccountHealthService)
// ?refresh=1 = "Check again" (بيتجاهل الكاش لو عدّى 20 ثانية)
export const accountHealthRouter = Router();

accountHealthRouter.get("/", async (req, res) => {
  res.json(await container.accountHealth.get(req.auth!.tenantId, { refresh: req.query.refresh === "1" }));
});
