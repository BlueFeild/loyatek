import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireSuperAdmin } from "../../middleware/auth";
import { AppError } from "../../core/errors";
import { SlidingWindowLimiter, envNumber } from "../../utils/rate-limit";
import { HelpDeskService } from "./help-desk.service";
import { EmailHelpMailer, PrismaHelpRepository } from "./help-desk.repository";

// صندوق "محتاج مساعدة؟" - الراوترات بس (التحقق في الخدمة)
//   التاجر:      /api/help/tickets           (أي دور، شركته بس)
//   السوبر أدمن: /api/super-admin/support   (كل الشركات)
const frontendBase = () => (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");
const service = new HelpDeskService(
  new PrismaHelpRepository(prisma),
  new EmailHelpMailer(),
  {
    adminTicket: (id) => `${frontendBase()}/super-admin?tab=support&ticket=${id}`,
    merchantTicket: (id) => `${frontendBase()}/dashboard?help=${id}`,
  },
  { maxTicketsPerHour: envNumber("SUPPORT_TICKETS_PER_HOUR", 10) }
);

const uuid = z.string().uuid();
function id(req: Request) {
  const v = req.params.id;
  if (!uuid.safeParse(v).success) throw new AppError(404, "NOT_FOUND", "Message not found");
  return v;
}

// الردود: حد بسيط لكل شركة (يمنع سكربت يغرق إيميل الدعم)
const replyLimiter = new SlidingWindowLimiter(envNumber("SUPPORT_REPLIES_PER_HOUR", 60), 60 * 60_000);

export const helpRouter = Router();
helpRouter.use(requireAuth);

const actor = (req: Request) => ({ tenantId: req.auth!.tenantId, userId: req.auth!.userId });

helpRouter.get("/tickets", async (req, res) => {
  res.json(await service.listMine(actor(req)));
});
helpRouter.post("/tickets", async (req, res) => {
  res.status(201).json(await service.create(actor(req), req.body));
});
helpRouter.get("/tickets/:id", async (req, res) => {
  res.json(await service.getMine(actor(req), id(req)));
});
helpRouter.post("/tickets/:id/replies", async (req, res) => {
  const ticketId = id(req);
  if (replyLimiter.hit(req.auth!.tenantId)) throw new AppError(429, "TOO_MANY_REPLIES", "Too many messages in a short time. Please wait a little.");
  res.status(201).json(await service.replyAsMerchant(actor(req), ticketId, req.body));
});

export const adminHelpRouter = Router();
adminHelpRouter.use(requireAuth, requireSuperAdmin);

adminHelpRouter.get("/", async (req, res) => {
  res.json(await service.adminList(req.query.status));
});
adminHelpRouter.get("/:id", async (req, res) => {
  res.json(await service.adminGet(id(req)));
});
adminHelpRouter.post("/:id/replies", async (req, res) => {
  res.status(201).json(await service.replyAsAdmin(req.auth!.userId, id(req), req.body));
});
adminHelpRouter.patch("/:id", async (req, res) => {
  res.json(await service.adminSetStatus(id(req), req.body));
});
