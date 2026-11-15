import { Router } from "express";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";

// سلاسل الرسايل (/api/whatsapp/sequences) - التحقق والمنطق في SequenceService
export const sequenceRouter = Router();

const editors = requireRole("OWNER", "ADMIN", "MANAGER");

sequenceRouter.get("/", async (req, res) => {
  res.json(await container.sequenceService.list(req.auth!.tenantId));
});

sequenceRouter.post("/", editors, async (req, res) => {
  res.status(201).json(await container.sequenceService.create(req.auth!.tenantId, req.body));
});

sequenceRouter.patch("/:id", editors, async (req, res) => {
  res.json(await container.sequenceService.update(req.auth!.tenantId, req.params.id, req.body));
});

sequenceRouter.delete("/:id", editors, async (req, res) => {
  await container.sequenceService.remove(req.auth!.tenantId, req.params.id);
  res.json({ ok: true });
});

sequenceRouter.get("/:id/people", async (req, res) => {
  res.json(await container.sequenceService.people(req.auth!.tenantId, req.params.id));
});

sequenceRouter.post("/:id/people", editors, async (req, res) => {
  res.json(await container.sequenceService.enrollPhones(req.auth!.tenantId, req.params.id, req.body));
});

sequenceRouter.post("/:id/people/:enrollmentId/stop", editors, async (req, res) => {
  res.json(await container.sequenceService.stopOne(req.auth!.tenantId, req.params.id, req.params.enrollmentId));
});
