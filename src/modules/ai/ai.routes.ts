import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { container } from "../../core/container";
import { zodMessage } from "../../utils/validation";
import { copyBriefSchema } from "./copy-generator";
import { COPY_COST } from "./copywriter.service";

const { copywriterService } = container;

// استوديو الذكاء الاصطناعي - الـ controller بيستقبل ويتأكد من البيانات بس، والمنطق في الخدمة
export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.get("/copywriter", async (req, res) => {
  res.json({ available: copywriterService.isAvailable, cost: COPY_COST, history: await copywriterService.history(req.auth!.tenantId) });
});

aiRouter.post("/copywriter", async (req, res) => {
  const parsed = copyBriefSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await copywriterService.write(req.auth!.tenantId, req.auth!.userId, parsed.data));
});
