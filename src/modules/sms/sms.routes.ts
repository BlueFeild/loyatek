import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, requireSuperAdmin } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { zodMessage } from "../../utils/validation";
import { ValidationError } from "../../core/errors";
import { smsService } from "./sms.module";
import { SMS_BODY_MAX } from "./sms-text";

// رسايل SMS - الراوترات بس (تحقق zod)، المنطق كله في SmsService
export const smsRouter = Router();
smsRouter.use(requireAuth, requireModule("sms"));
const canSend = requireRole("OWNER", "ADMIN", "MANAGER");

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new ValidationError(zodMessage(r.error));
  return r.data;
}

smsRouter.get("/overview", async (req, res) => {
  res.json(await smsService.overview(req.auth!.tenantId));
});

smsRouter.get("/settings", async (req, res) => {
  res.json(await smsService.settings(req.auth!.tenantId));
});

smsRouter.patch("/settings", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const { senderName } = parse(z.object({ senderName: z.string().max(40).nullable() }), req.body);
  res.json(await smsService.updateSender(req.auth!.tenantId, senderName));
});

const sendSchema = z.object({ to: z.string().min(1).max(40), body: z.string().min(1).max(SMS_BODY_MAX) });
smsRouter.post("/send", canSend, async (req, res) => {
  const { to, body } = parse(sendSchema, req.body);
  res.json(await smsService.sendOne(req.auth!.tenantId, req.auth!.userId, to, body));
});

smsRouter.get("/messages", async (req, res) => {
  const q = parse(
    z.object({
      status: z.enum(["QUEUED", "SENT", "DELIVERED", "FAILED"]).optional(),
      campaignId: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }),
    req.query
  );
  res.json(await smsService.messages(req.auth!.tenantId, q));
});

// التاجات من دفتر جهات الاتصال (نفس دفتر الواتساب) وعدد كل واحد
smsRouter.get("/audience", async (req, res) => {
  res.json(await smsService.audience(req.auth!.tenantId));
});

const campaignFields = {
  name: z.string().trim().min(1, "Please name the campaign").max(120),
  body: z.string().trim().min(1, "Please write the message").max(SMS_BODY_MAX),
  audienceTags: z.array(z.string().max(60)).max(30).optional(),
  audienceMatch: z.enum(["any", "all"]).optional(),
  pasted: z.string().max(400_000).nullable().optional(),
};

smsRouter.get("/campaigns", async (req, res) => {
  res.json(await smsService.listCampaigns(req.auth!.tenantId));
});

smsRouter.post("/campaigns", canSend, async (req, res) => {
  const data = parse(z.object(campaignFields), req.body);
  res.status(201).json(await smsService.createCampaign(req.auth!.tenantId, data));
});

smsRouter.get("/campaigns/:id", async (req, res) => {
  res.json(await smsService.getCampaign(req.auth!.tenantId, req.params.id));
});

smsRouter.patch("/campaigns/:id", canSend, async (req, res) => {
  const data = parse(z.object(campaignFields).partial(), req.body);
  res.json(await smsService.updateCampaign(req.auth!.tenantId, req.params.id, data));
});

smsRouter.delete("/campaigns/:id", canSend, async (req, res) => {
  res.json(await smsService.deleteCampaign(req.auth!.tenantId, req.params.id));
});

smsRouter.get("/campaigns/:id/estimate", async (req, res) => {
  res.json(await smsService.estimate(req.auth!.tenantId, req.params.id));
});

smsRouter.post("/campaigns/:id/send", canSend, async (req, res) => {
  res.status(202).json(await smsService.start(req.auth!.tenantId, req.params.id, req.auth!.userId));
});

smsRouter.post("/campaigns/:id/schedule", canSend, async (req, res) => {
  const { at } = parse(z.object({ at: z.string().datetime({ offset: true }) }), req.body);
  res.json(await smsService.schedule(req.auth!.tenantId, req.params.id, new Date(at)));
});

smsRouter.delete("/campaigns/:id/schedule", canSend, async (req, res) => {
  res.json(await smsService.unschedule(req.auth!.tenantId, req.params.id));
});

smsRouter.get("/campaigns/:id/report", async (req, res) => {
  res.json(await smsService.report(req.auth!.tenantId, req.params.id));
});

// السوبر أدمن: رصيد الرسايل لكل شركة (إضافة / خصم مع ملاحظة)
export const adminSmsRouter = Router();
adminSmsRouter.use(requireAuth, requireSuperAdmin);

adminSmsRouter.get("/:tenantId", async (req, res) => {
  res.json(await smsService.adminView(req.params.tenantId));
});

adminSmsRouter.post("/:tenantId", async (req, res) => {
  const { amount, note } = parse(
    z.object({
      amount: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Amount can't be 0"),
      note: z.string().trim().max(200).optional(),
    }),
    req.body
  );
  res.json(await smsService.adminAdjust(req.params.tenantId, amount, note, req.auth!.userId));
});
