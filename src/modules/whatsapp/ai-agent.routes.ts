import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { ValidationError } from "../../core/errors";
import { AGENT_DIALECTS, AGENT_LIMITS } from "../ai/agent-types";

// موظف واتساب الذكي (/api/whatsapp/ai-agent) - التحقق هنا، المنطق في AiAgentService
export const aiAgentRouter = Router();

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

aiAgentRouter.get("/", async (req, res) => {
  res.json(await container.aiAgentService.getSettings(req.auth!.tenantId));
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  knowledge: z.string().max(AGENT_LIMITS.maxKnowledgeChars, `Keep the business info under ${AGENT_LIMITS.maxKnowledgeChars} characters.`).optional(),
  dialect: z.enum(AGENT_DIALECTS).optional(),
  maxRepliesPerHour: z.number().int().min(1).max(30).optional(),
});

aiAgentRouter.put("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  res.json(await container.aiAgentService.saveSettings(req.auth!.tenantId, parse(settingsSchema, req.body)));
});

const testSchema = z.object({
  message: z.string().trim().min(1, "Write a message to test with.").max(2000),
  history: z.array(z.object({ from: z.enum(["customer", "business"]), text: z.string().max(2000) })).max(20).optional(),
});

aiAgentRouter.post("/test", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const body = parse(testSchema, req.body);
  res.json(await container.aiAgentService.test(req.auth!.tenantId, req.auth!.userId, body.message, body.history ?? []));
});
