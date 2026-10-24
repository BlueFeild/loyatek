import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { container } from "../../core/container";
import { zodMessage } from "../../utils/validation";

const { creditService } = container;

// رصيد الشركة الحالية + آخر الحركات
export const creditsRouter = Router();
creditsRouter.use(requireAuth);

creditsRouter.get("/", async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [balance, history] = await Promise.all([creditService.getBalance(tenantId), creditService.history(tenantId)]);
  res.json({ ...balance, history });
});

// السوبر أدمن: إضافة/خصم نقاط لأي شركة (هدية، تعويض، باقة اتدفعت برّه)
export const adminCreditsRouter = Router();
adminCreditsRouter.use(requireAuth, requireSuperAdmin);

const grantSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, "Amount can't be 0"),
  note: z.string().trim().max(200).optional(),
});

adminCreditsRouter.get("/:tenantId", async (req, res) => {
  const [balance, history] = await Promise.all([creditService.getBalance(req.params.tenantId), creditService.history(req.params.tenantId)]);
  res.json({ ...balance, history });
});

adminCreditsRouter.post("/:tenantId", async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });
  const balance = await creditService.grant(req.params.tenantId, parsed.data.amount, req.auth!.userId, parsed.data.note);
  res.json({ balance });
});
