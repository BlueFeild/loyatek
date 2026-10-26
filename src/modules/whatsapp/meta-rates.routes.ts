import { Router } from "express";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { container } from "../../core/container";
import { zodMessage } from "../../utils/validation";
import { metaRateTableSchema } from "./meta-rates";

const { metaRatesService } = container;

// عام: صفحة الأسعار بتعرض تكلفة رسايل Meta التقريبية (من غير تسجيل دخول)
export const publicMetaRatesRouter = Router();
publicMetaRatesRouter.get("/", async (_req, res) => {
  res.json(await metaRatesService.publicView());
});

// السوبر أدمن: يعدّل الأسعار لما Meta تغيّرها
export const adminMetaRatesRouter = Router();
adminMetaRatesRouter.use(requireAuth, requireSuperAdmin);

adminMetaRatesRouter.get("/", async (_req, res) => {
  res.json(await metaRatesService.publicView());
});

adminMetaRatesRouter.put("/", async (req, res) => {
  const parsed = metaRateTableSchema.safeParse(req.body?.rates ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  res.json(await metaRatesService.replace(parsed.data));
});
