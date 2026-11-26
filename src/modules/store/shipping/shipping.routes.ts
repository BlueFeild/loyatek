import { Router, type Request } from "express";
import { z } from "zod";
import { requireRole } from "../../../middleware/auth";
import { AppError, ValidationError } from "../../../core/errors";
import { zodMessage } from "../../../utils/validation";
import { shippingService as svc } from "./shipping.wiring";
import { CARRIERS, type CarrierCode } from "./shipping.types";

// الشحن (لوحة التاجر) - بيتركب جوه storeRouter (يعني requireAuth + module store قبله)
// المفاتيح: OWNER/ADMIN بس. الطرق والعنوان وإنشاء الشحنة: المديرين. التتبع والبوليصة: أي موظف
const owners = requireRole("OWNER", "ADMIN");
const editors = requireRole("OWNER", "ADMIN", "MANAGER");
const staff = requireRole("OWNER", "ADMIN", "MANAGER", "STAFF");
const tid = (req: Request) => req.auth!.tenantId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderId = (v: string) => {
  if (!UUID.test(v)) throw new AppError(404, "NOT_FOUND", "Order not found");
  return v;
};
const carrierParam = (v: string): CarrierCode => {
  const c = v.toUpperCase();
  if (!(CARRIERS as readonly string[]).includes(c)) throw new AppError(404, "NOT_FOUND", "Unknown shipping company");
  return c as CarrierCode;
};
function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const p = schema.safeParse(req.body ?? {});
  if (!p.success) throw new ValidationError(zodMessage(p.error));
  return p.data;
}

const connectInput = z.object({ mode: z.enum(["TEST", "LIVE"]), credentials: z.record(z.string(), z.unknown()) }).strict();
const shipmentInput = z
  .object({
    carrier: z.enum(CARRIERS).optional(),
    service: z.string().trim().max(40).nullable().optional(),
    weightKg: z.number().finite().min(0.01).max(1000).optional(),
    lengthCm: z.number().finite().min(1).max(300).optional(),
    widthCm: z.number().finite().min(1).max(300).optional(),
    heightCm: z.number().finite().min(1).max(300).optional(),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a 2-letter country code").optional(),
    city: z.string().trim().max(80).optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
  })
  .strict();

export const shippingRouter = Router();
shippingRouter.get("/", async (req, res) => res.json(await svc.settingsView(tid(req))));
shippingRouter.put("/methods", editors, async (req, res) => res.json(await svc.saveMethods(tid(req), (req.body ?? {}).methods)));
shippingRouter.delete("/methods", editors, async (req, res) => res.json(await svc.resetMethods(tid(req))));
shippingRouter.put("/origin", editors, async (req, res) => res.json(await svc.saveOrigin(tid(req), req.body)));
shippingRouter.put("/package", editors, async (req, res) => res.json(await svc.savePackage(tid(req), req.body)));
shippingRouter.post("/carriers/:carrier", owners, async (req, res) => {
  const input = body(connectInput, req);
  res.json(await svc.connect(tid(req), carrierParam(req.params.carrier), input.mode, input.credentials));
});
shippingRouter.post("/carriers/:carrier/test", owners, async (req, res) => res.json(await svc.testConnection(tid(req), carrierParam(req.params.carrier))));
shippingRouter.delete("/carriers/:carrier", owners, async (req, res) => res.json(await svc.disconnect(tid(req), carrierParam(req.params.carrier))));

// شحنة الطلب: /api/store/orders/:id/shipment
export const orderShipmentRouter = Router({ mergeParams: true });
orderShipmentRouter.get("/", staff, async (req, res) => res.json({ shipment: await svc.orderShipment(tid(req), orderId(req.params.id)) }));
orderShipmentRouter.post("/", editors, async (req, res) => res.status(201).json({ shipment: await svc.createShipment(tid(req), orderId(req.params.id), body(shipmentInput, req)) }));
orderShipmentRouter.post("/track", staff, async (req, res) => res.json({ shipment: await svc.refreshTracking(tid(req), orderId(req.params.id)) }));
orderShipmentRouter.get("/label", staff, async (req, res) => {
  const l = await svc.label(tid(req), orderId(req.params.id));
  if ("url" in l) return res.json({ url: l.url });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${l.fileName.replace(/[^\w.-]/g, "_")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(l.pdf);
});
