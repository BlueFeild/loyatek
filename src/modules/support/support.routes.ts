import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { assertTenantOwns } from "../../utils/tenant-owned";

export const supportRouter = Router();
supportRouter.use(requireAuth, requireModule("erp"));

supportRouter.get("/tickets", async (req, res) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { customer: { select: { id: true, name: true, phone: true } }, replies: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(tickets);
});

const createTicketSchema = z.object({
  subject: z.string().min(1),
  customerId: z.string().uuid().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

supportRouter.post("/tickets", async (req, res) => {
  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await assertTenantOwns(req.auth!.tenantId, { customerIds: [parsed.data.customerId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      tenantId: req.auth!.tenantId,
      subject: parsed.data.subject,
      customerId: parsed.data.customerId ?? undefined,
      priority: parsed.data.priority,
    },
    include: { customer: { select: { id: true, name: true, phone: true } }, replies: true },
  });
  res.status(201).json(ticket);
});

const updateTicketSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
});

supportRouter.patch("/tickets/:id", async (req, res) => {
  const parsed = updateTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  // الأولوية للإدارة بس (تدقيق ERP-12) - الموظف يغيّر الحالة
  if (parsed.data.priority !== undefined && req.auth!.role === "STAFF") return res.status(403).json({ error: "Only managers can change the priority" });

  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: parsed.data,
    include: { customer: { select: { id: true, name: true, phone: true } }, replies: { orderBy: { createdAt: "asc" } } },
  });
  res.json(updated);
});

// اسم اللي رد بيتاخد من حسابه (تدقيق ERP-12) - authorName اللي جاي من المتصفح بيتجاهل
const addReplySchema = z.object({ authorName: z.string().optional(), message: z.string().trim().min(1).max(5000) });

supportRouter.post("/tickets/:id/replies", async (req, res) => {
  const parsed = addReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const me = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { name: true, email: true } });
  const reply = await prisma.supportTicketReply.create({
    data: { ticketId: ticket.id, authorName: me?.name || me?.email || "Team member", message: parsed.data.message },
  });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "IN_PROGRESS" } });
  res.status(201).json(reply);
});
