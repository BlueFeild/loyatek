import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { ValidationError } from "../../core/errors";

// سيناريوهات واتساب (/api/whatsapp/flows) - التحقق الكامل للسيناريو في FlowService
export const flowRouter = Router();

const editors = requireRole("OWNER", "ADMIN", "MANAGER");

flowRouter.get("/", async (req, res) => {
  res.json(await container.flowService.list(req.auth!.tenantId));
});

flowRouter.post("/", editors, async (req, res) => {
  res.status(201).json(await container.flowService.create(req.auth!.tenantId, req.body));
});

// جرّب سيناريو (حتى لو لسه متحفظش) - مابيبعتش حاجة
const testSchema = z.object({
  flow: z.unknown(),
  state: z.object({ nodeId: z.string().max(40), answers: z.record(z.string().max(500)) }).nullable().optional(),
  text: z.string().max(1000).default(""),
  replyId: z.string().max(80).nullable().optional(),
});

flowRouter.post("/test", editors, async (req, res) => {
  const r = testSchema.safeParse(req.body);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid request");
  res.json(await container.flowService.test(req.auth!.tenantId, r.data.flow, r.data.state ?? null, { text: r.data.text, replyId: r.data.replyId ?? null }));
});

flowRouter.put("/:id", editors, async (req, res) => {
  res.json(await container.flowService.update(req.auth!.tenantId, req.params.id, req.body));
});

flowRouter.patch("/:id", editors, async (req, res) => {
  const r = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!r.success) throw new ValidationError("enabled must be true or false");
  res.json(await container.flowService.setEnabled(req.auth!.tenantId, req.params.id, r.data.enabled));
});

flowRouter.delete("/:id", editors, async (req, res) => {
  await container.flowService.remove(req.auth!.tenantId, req.params.id);
  res.status(204).end();
});

flowRouter.get("/:id/responses", async (req, res) => {
  res.json(await container.flowService.responses(req.auth!.tenantId, req.params.id));
});
