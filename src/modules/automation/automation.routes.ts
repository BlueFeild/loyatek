import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";

export const automationRouter = Router();
automationRouter.use(requireAuth);

automationRouter.get("/rules", async (req, res) => {
  const rules = await prisma.automationRule.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });
  res.json(rules);
});

const createRuleSchema = z.object({
  name: z.string().min(1),
  triggerType: z.string().min(1),
  triggerConfig: z.record(z.any()).default({}),
  actionType: z.string().min(1),
  actionConfig: z.record(z.any()).default({}),
});

automationRouter.post("/rules", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createRuleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rule = await prisma.automationRule.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(rule);
});

const updateRuleSchema = z.object({ enabled: z.boolean().optional() });

automationRouter.patch("/rules/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateRuleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  const updated = await prisma.automationRule.update({ where: { id: rule.id }, data: parsed.data });
  res.json(updated);
});

automationRouter.delete("/rules/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const rule = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  await prisma.automationRule.delete({ where: { id: rule.id } });
  res.json({ ok: true });
});
