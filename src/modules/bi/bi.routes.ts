import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { getRevenueTrend, getBranchPerformance } from "./bi.service";

export const biRouter = Router();

biRouter.use(requireAuth, requireModule("erp"));

biRouter.get("/revenue-trend", async (req, res) => {
  // من 1 لـ 366 يوم بس: قبل كده ?days=رقم ضخم كان بيعمل loop يوقّف السيرفر (تدقيق ERP-02)
  const asked = Math.floor(Number(req.query.days ?? 30));
  const days = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 366) : 30;
  const trend = await getRevenueTrend(req.auth!.tenantId, days);
  res.json(trend);
});

biRouter.get("/branch-performance", async (req, res) => {
  const performance = await getBranchPerformance(req.auth!.tenantId);
  res.json(performance);
});
