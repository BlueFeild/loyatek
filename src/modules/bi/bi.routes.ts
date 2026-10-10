import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { getRevenueTrend, getBranchPerformance } from "./bi.service";

export const biRouter = Router();

biRouter.use(requireAuth);

biRouter.get("/revenue-trend", async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 30;
  const trend = await getRevenueTrend(req.auth!.tenantId, days);
  res.json(trend);
});

biRouter.get("/branch-performance", async (req, res) => {
  const performance = await getBranchPerformance(req.auth!.tenantId);
  res.json(performance);
});
