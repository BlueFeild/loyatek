import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth } from "../../middleware/auth";

export const supportRouter = Router();
supportRouter.use(requireAuth);

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

  const updated = await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: parsed.data,
    include: { customer: { select: { id: true, name: true, phone: true } }, replies: { orderBy: { createdAt: "asc" } } },
  });
  res.json(updated);
});

const addReplySchema = z.object({ authorName: z.string().min(1), message: z.string().min(1) });

supportRouter.post("/tickets/:id/replies", async (req, res) => {
  const parsed = addReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const reply = await prisma.supportTicketReply.create({
    data: { ticketId: ticket.id, ...parsed.data },
  });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "IN_PROGRESS" } });
  res.status(201).json(reply);
});
