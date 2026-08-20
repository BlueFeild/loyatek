import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { createInvoice, issueInvoice, getVatReport } from "./invoices.service";

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth);

invoicesRouter.get("/", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { items: true, customer: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(invoices);
});

const createInvoiceSchema = z.object({
  branchId: z.string().uuid(),
  customerId: z.string().uuid(),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPrice: z.number().min(0),
      })
    )
    .min(1),
});

invoicesRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const invoice = await createInvoice({ tenantId: req.auth!.tenantId, ...parsed.data });
  res.status(201).json(invoice);
});

// إصدار الفاتورة - بيحسب الضريبة، يولّد الـ QR، وينشئ القيد المحاسبي تلقائيًا
invoicesRouter.post("/:id/issue", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const invoice = await issueInvoice(req.auth!.tenantId, req.params.id);
    res.json(invoice);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const vatReportSchema = z.object({
  start: z.string(),
  end: z.string(),
});

// تقرير ضريبة بضغطة واحدة - إجمالي VAT محصّل من فواتير حقيقية في فترة معيّنة
invoicesRouter.get("/vat-report", async (req, res) => {
  const parsed = vatReportSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const report = await getVatReport(req.auth!.tenantId, new Date(parsed.data.start), new Date(parsed.data.end));
  res.json(report);
});
