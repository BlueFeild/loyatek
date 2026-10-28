import { Router } from "express";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { zodMessage } from "../../utils/validation";
import { adBudgetSchema, boostSchema, citySearchSchema } from "./social.schemas";

const { socialAdsService } = container;

// الإعلانات المدفوعة (جوه /api/social - نفس شرط اشتراك استوديو الذكاء الاصطناعي).
// صرف الفلوس (تمويل / تشغيل / تغيير الميزانية) = صاحب الشركة أو الأدمن بس
export const adsRouter = Router();
const canSpend = requireRole("OWNER", "ADMIN");

adsRouter.get("/", async (req, res) => {
  res.json(await socialAdsService.list(req.auth!.tenantId));
});

adsRouter.get("/ad-accounts", async (req, res) => {
  res.json(await socialAdsService.adAccounts(req.auth!.tenantId));
});

adsRouter.get("/cities", async (req, res) => {
  const parsed = citySearchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialAdsService.searchCities(req.auth!.tenantId, parsed.data.q));
});

adsRouter.post("/boost", canSpend, async (req, res) => {
  const parsed = boostSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.status(201).json(await socialAdsService.boost(req.auth!.tenantId, req.auth!.userId, parsed.data));
});

adsRouter.get("/:id", async (req, res) => {
  res.json(await socialAdsService.get(req.auth!.tenantId, req.params.id));
});

adsRouter.post("/:id/pause", canSpend, async (req, res) => {
  res.json(await socialAdsService.pause(req.auth!.tenantId, req.auth!.userId, req.params.id));
});

adsRouter.post("/:id/resume", canSpend, async (req, res) => {
  res.json(await socialAdsService.resume(req.auth!.tenantId, req.auth!.userId, req.params.id));
});

adsRouter.patch("/:id/budget", canSpend, async (req, res) => {
  const parsed = adBudgetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await socialAdsService.changeBudget(req.auth!.tenantId, req.auth!.userId, req.params.id, parsed.data.dailyBudget));
});
