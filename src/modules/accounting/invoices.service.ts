import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { generateZatcaQrPayload } from "./zatca-qr";

export const VAT_RATE = 0.05; // 5% - نفس المعيار المستخدم في دول الخليج

interface InvoiceItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface CreateInvoiceInput {
  tenantId: string;
  branchId: string;
  customerId: string;
  items: InvoiceItemInput[];
}

async function nextInvoiceNumber(tenantId: string): Promise<string> {
  const count = await prisma.invoice.count({ where: { tenantId } });
  return `INV-${String(count + 1).padStart(4, "0")}`;
}

// إنشاء فاتورة مسودة - لسه ما اتصدرتش، مفيش قيد محاسبي ولا QR لسه
export async function createInvoice(input: CreateInvoiceInput) {
  const subtotal = input.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const vatAmount = Math.round(subtotal * VAT_RATE * 100) / 100;
  const total = subtotal + vatAmount;

  return prisma.invoice.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      customerId: input.customerId,
      invoiceNumber: await nextInvoiceNumber(input.tenantId),
      subtotal,
      vatAmount,
      total,
      items: { create: input.items },
    },
    include: { items: true, customer: true },
  });
}

// أهم عملية: إصدار الفاتورة فعليًا. ده بيعمل 3 حاجات سوا جوه transaction واحدة:
// 1. يتأكد إن حسابات Accounts Receivable و VAT Payable موجودة (بينشئهم لو مش موجودين)
// 2. يعمل قيد محاسبي حقيقي: مدين Accounts Receivable بإجمالي الفاتورة،
//    دائن Sales Revenue بالقيمة قبل الضريبة، دائن VAT Payable بقيمة الضريبة
// 3. يولّد QR كود حقيقي (Base64 TLV) ويربطه بالفاتورة، ويغيّر حالتها لـ ISSUED
export async function issueInvoice(tenantId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { items: true, customer: true },
  });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error(`Invoice is already ${invoice.status}`);

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new Error("Tenant not found");
  if (!tenant.vatNumber) {
    throw new Error("Set the company VAT number first (PATCH /api/tenants/vat-number) before issuing invoices");
  }

  const [arAccount, revenueAccount, vatAccount] = await Promise.all([
    prisma.account.upsert({
      where: { tenantId_code: { tenantId, code: "1100" } },
      update: {},
      create: { tenantId, code: "1100", name: "Accounts Receivable", type: "ASSET" },
    }),
    prisma.account.upsert({
      where: { tenantId_code: { tenantId, code: "4000" } },
      update: {},
      create: { tenantId, code: "4000", name: "Sales Revenue", type: "REVENUE" },
    }),
    prisma.account.upsert({
      where: { tenantId_code: { tenantId, code: "2100" } },
      update: {},
      create: { tenantId, code: "2100", name: "VAT Payable", type: "LIABILITY" },
    }),
  ]);

  const subtotal = Number(invoice.subtotal);
  const vatAmount = Number(invoice.vatAmount);
  const total = Number(invoice.total);
  const issuedAt = new Date();

  const qrPayload = generateZatcaQrPayload({
    sellerName: tenant.name,
    vatNumber: tenant.vatNumber,
    timestamp: issuedAt.toISOString(),
    invoiceTotal: total.toFixed(2),
    vatAmount: vatAmount.toFixed(2),
  });

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const journalEntry = await tx.journalEntry.create({
      data: {
        tenantId,
        description: `Invoice ${invoice.invoiceNumber} issued to ${invoice.customer.name}`,
        date: issuedAt,
        lines: {
          create: [
            { accountId: arAccount.id, debit: total },
            { accountId: revenueAccount.id, credit: subtotal },
            { accountId: vatAccount.id, credit: vatAmount },
          ],
        },
      },
    });

    return tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "ISSUED", issuedAt, qrPayload, journalEntryId: journalEntry.id },
      include: { items: true, customer: true },
    });
  });

  return result;
}

// تقرير الضريبة: إجمالي VAT المحصّل من كل الفواتير المُصدرة في فترة معيّنة،
// محسوب من فواتير حقيقية مش رقم مجمّع يدويًا
export async function getVatReport(tenantId: string, start: Date, end: Date) {
  const invoices = await prisma.invoice.findMany({
    where: { tenantId, status: { in: ["ISSUED", "PAID"] }, issuedAt: { gte: start, lte: end } },
    include: { customer: true },
    orderBy: { issuedAt: "asc" },
  });

  const totalSubtotal = invoices.reduce((sum: number, i: { subtotal: unknown }) => sum + Number(i.subtotal), 0);
  const totalVat = invoices.reduce((sum: number, i: { vatAmount: unknown }) => sum + Number(i.vatAmount), 0);
  const totalWithVat = invoices.reduce((sum: number, i: { total: unknown }) => sum + Number(i.total), 0);

  return { period: { start, end }, invoiceCount: invoices.length, totalSubtotal, totalVat, totalWithVat, invoices };
}
