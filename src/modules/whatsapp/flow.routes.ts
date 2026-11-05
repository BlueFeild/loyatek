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
