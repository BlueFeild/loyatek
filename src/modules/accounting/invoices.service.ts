import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import { generateZatcaQrPayload } from "./zatca-qr";
import { getTenantMoney, payableAmount } from "../../utils/money";
import { assertTenantOwns } from "../../utils/tenant-owned";
import { isUniqueViolation } from "../../utils/prisma-errors";

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
  dueDate?: Date | null;
  notes?: string | null;
}

// الرقم الجاي = أكبر رقم INV-xxxx موجود + 1 (مش عدد الفواتير: مسح مسودة كان بيكرّر رقم).
// فاتورتين في نفس اللحظة ممكن ياخدوا نفس الرقم → الـ unique بيرفض التانية فنجرّب الرقم اللي بعده (تدقيق ERP-10)
async function nextInvoiceNumber(tenantId: string, bump = 0): Promise<string> {
  const rows = await prisma.$queryRaw<{ n: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("invoiceNumber" FROM 5) AS INTEGER)) AS n
    FROM invoices WHERE "tenantId" = ${tenantId} AND "invoiceNumber" ~ '^INV-[0-9]{1,9}$'`;
  const last = Number(rows[0]?.n ?? 0);
  return `INV-${String(last + 1 + bump).padStart(4, "0")}`;
}

// إنشاء فاتورة مسودة - لسه ما اتصدرتش، مفيش قيد محاسبي ولا QR لسه
export async function createInvoice(input: CreateInvoiceInput) {
  // العميل والفرع لازم يكونوا تبع نفس الشركة
  await assertTenantOwns(input.tenantId, { branchIds: [input.branchId], customerIds: [input.customerId] });
  const subtotal = input.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const vatAmount = Math.round(subtotal * VAT_RATE * 100) / 100;
  const total = subtotal + vatAmount;

  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.invoice.create({
        data: {
          tenantId: input.tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          dueDate: input.dueDate ?? null,
          notes: input.notes ?? null,
          invoiceNumber: await nextInvoiceNumber(input.tenantId, attempt),
          subtotal,
          vatAmount,
          total,
          items: { create: input.items },
        },
        include: { items: true, customer: true },
      });
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 8) throw err;
    }
  }
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

  // createMany + skipDuplicates بدل upsert: طلبين في نفس اللحظة كانوا بيعملوا نفس الحساب مرتين (P2002)
  await prisma.account.createMany({
    data: [
      { tenantId, code: "1100", name: "Accounts Receivable", type: "ASSET" },
      { tenantId, code: "4000", name: "Sales Revenue", type: "REVENUE" },
      { tenantId, code: "2100", name: "VAT Payable", type: "LIABILITY" },
    ],
    skipDuplicates: true,
  });
  const accounts = await prisma.account.findMany({ where: { tenantId, code: { in: ["1100", "4000", "2100"] } } });
  const byCode = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error("Accounting setup failed, please try again");
    return a;
  };
  const [arAccount, revenueAccount, vatAccount] = [byCode("1100"), byCode("4000"), byCode("2100")];

  const subtotal = Number(invoice.subtotal);
  const vatAmount = Number(invoice.vatAmount);
  const total = Number(invoice.total);
  const issuedAt = new Date();

  // المبالغ متخزنة بالدولار - كود الفاتورة (ZATCA) لازم يبقى بعملة الشركة (ريال مثلًا)
  const money = await getTenantMoney(tenantId);
  const qrPayload = generateZatcaQrPayload({
    sellerName: tenant.name,
    vatNumber: tenant.vatNumber,
    timestamp: issuedAt.toISOString(),
    invoiceTotal: payableAmount(total, money.currency, money.rates).toFixed(2),
    vatAmount: payableAmount(vatAmount, money.currency, money.rates).toFixed(2),
  });

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // claim ذري: بس طلب واحد يقدر ينقل الفاتورة من DRAFT (قبل كده الإصدار المتزامن كان بيعمل قيود مكررة)
    const claimed = await tx.invoice.updateMany({
      where: { id: invoice.id, tenantId, status: "DRAFT" },
      data: { status: "ISSUED", issuedAt },
    });
    if (claimed.count === 0) throw new Error("Invoice is already issued");
    const journalEntry = await tx.journalEntry.create({
      data: {
        tenantId,
        // قيد الفاتورة تبع فرعها (حسابات كل فرع لوحدها)
        branchId: invoice.branchId,
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
