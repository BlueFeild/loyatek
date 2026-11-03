import { Router } from "express";
import { z } from "zod";
import * as XLSX from "xlsx";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { ValidationError } from "../../core/errors";

// دفتر جهات اتصال واتساب (/api/whatsapp/contact-book) - التحقق هنا، المنطق في ContactBookService
export const contactBookRouter = Router();

const EDITORS = ["OWNER", "ADMIN", "MANAGER"] as const;
const tagsField = z.union([z.array(z.string().max(60)).max(50), z.string().max(1000)]).optional();

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
}

const listSchema = z.object({
  q: z.string().max(100).optional(),
  tag: z.string().max(60).optional(),
  status: z.enum(["all", "subscribed", "opted_out"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
});

contactBookRouter.get("/", async (req, res) => {
  res.json(await container.contactBookService.list(req.auth!.tenantId, parse(listSchema, req.query)));
});

const createSchema = z.object({ phone: z.string().min(4).max(30), name: z.string().max(120).nullable().optional(), tags: tagsField });

contactBookRouter.post("/", requireRole(...EDITORS, "STAFF"), async (req, res) => {
  res.status(201).json(await container.contactBookService.create(req.auth!.tenantId, parse(createSchema, req.body)));
});

const updateSchema = z.object({ name: z.string().max(120).nullable().optional(), tags: tagsField, optedOut: z.boolean().optional() });

contactBookRouter.patch("/:id", requireRole(...EDITORS, "STAFF"), async (req, res) => {
  res.json(await container.contactBookService.update(req.auth!.tenantId, req.params.id, parse(updateSchema, req.body)));
});

contactBookRouter.delete("/:id", requireRole(...EDITORS), async (req, res) => {
  res.json(await container.contactBookService.remove(req.auth!.tenantId, req.params.id));
});

// ملف إكسل أو CSV (base64): أعمدة Phone / Name / Tags (بأي اسم قريب، عربي أو إنجليزي)
const importSchema = z.object({ fileBase64: z.string().min(1).max(15_000_000), tags: tagsField });

contactBookRouter.post("/import", requireRole(...EDITORS), async (req, res) => {
  const body = parse(importSchema, req.body);
  let rows: Record<string, unknown>[];
  try {
    const workbook = XLSX.read(Buffer.from(body.fileBase64, "base64"), { type: "buffer" });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  } catch {
    throw new ValidationError("Couldn't read this file — upload an Excel (.xlsx) or CSV file.");
  }
  res.json(await container.contactBookService.importRows(req.auth!.tenantId, rows, body.tags));
});

contactBookRouter.post("/sync-customers", requireRole(...EDITORS), async (req, res) => {
  res.json(await container.contactBookService.syncCustomers(req.auth!.tenantId));
});

const bulkSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), add: tagsField, remove: tagsField });

contactBookRouter.post("/bulk-tags", requireRole(...EDITORS, "STAFF"), async (req, res) => {
  const body = parse(bulkSchema, req.body);
  res.json(await container.contactBookService.bulkTags(req.auth!.tenantId, body.ids, body.add, body.remove));
});

const countSchema = z.object({ tags: z.string().max(1000).default(""), match: z.enum(["any", "all"]).default("any") });

contactBookRouter.get("/audience-count", async (req, res) => {
  const q = parse(countSchema, req.query);
  res.json(await container.contactBookService.audienceCount(req.auth!.tenantId, q.tags, q.match));
});
