import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { ValidationError } from "../../core/errors";

// أرقام واتساب الإضافية (/api/whatsapp/numbers) - المنطق في WhatsappNumbersService
export const whatsappNumbersRouter = Router();

const admins = requireRole("OWNER", "ADMIN");

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

const phoneId = z.string().trim().regex(/^\d{5,30}$/, "Phone number ID is a long number from Meta (not the phone itself)");

whatsappNumbersRouter.get("/", async (req, res) => {
  res.json(await container.whatsappNumbers.list(req.auth!.tenantId));
});

const addSchema = z.object({
  label: z.string().trim().min(1, "Give the number a name, e.g. the branch").max(60),
  phoneNumberId: phoneId,
  wabaId: z.string().trim().regex(/^\d{5,30}$/, "WABA ID is a long number from Meta").optional().nullable(),
  branchId: z.string().uuid().optional().nullable(),
  accessToken: z.string().trim().max(1000).optional().nullable(),
});

whatsappNumbersRouter.post("/", admins, async (req, res) => {
  res.status(201).json(await container.whatsappNumbers.add(req.auth!.tenantId, parse(addSchema, req.body)));
});

whatsappNumbersRouter.post("/:id/verify", admins, async (req, res) => {
  res.json(await container.whatsappNumbers.reverify(req.auth!.tenantId, req.params.id));
});

whatsappNumbersRouter.patch("/:id", admins, async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1).max(60).optional(), branchId: z.string().uuid().nullable().optional() }), req.body);
  await container.whatsappNumbers.update(req.auth!.tenantId, req.params.id, body);
  res.json({ ok: true });
});

whatsappNumbersRouter.delete("/:id", admins, async (req, res) => {
  await container.whatsappNumbers.remove(req.auth!.tenantId, req.params.id);
  res.status(204).end();
});
