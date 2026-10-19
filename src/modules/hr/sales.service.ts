import { prisma } from "../../config/db";
import { assertTenantOwns } from "../../utils/tenant-owned";

async function getOrCreateAccount(tx: any, tenantId: string, code: string, name: string, type: string) {
  const found = await tx.account.findFirst({ where: { tenantId, code } });
  return found ?? tx.account.create({ data: { tenantId, code, name, type } });
}

interface RecordSaleInput {
  tenantId: string;
  branchId: string;
  employeeId: string;
  itemId: string;
  quantity: number;
  customerId?: string;
}

// أهم عملية في الموديول: تسجيل بيع فعلي. ده بيعمل 3 حاجات سوا
// جوه transaction واحدة - مفيش خطوة بتحصل من غير التانية:
// 1. يتأكد إن المخزون كافي وينقص الكمية فعليًا
// 2. يسجّل حركة مخزون (OUT) حقيقية - نفس منطق الـ Inventory module
// 3. يحسب العمولة تلقائيًا حسب نسبة الموظف، ويسجّل عملية البيع كسجل قابل للتدقيق
// 4. يعمل قيد في الدفاتر (مدين الخزنة / دائن المبيعات)
export async function recordSale(input: RecordSaleInput) {
  // الفرع والعميل لازم يكونوا تبع نفس الشركة (الصنف والموظف متشيّكين تحت)
  await assertTenantOwns(input.tenantId, { branchIds: [input.branchId], customerIds: [input.customerId] });

  const item = await prisma.inventoryItem.findFirst({
    where: { id: input.itemId, tenantId: input.tenantId },
  });
  if (!item) throw new Error("Inventory item not found");
  if (item.quantity < input.quantity) {
    throw new Error(`Insufficient stock: only ${item.quantity} units available`);
  }

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, tenantId: input.tenantId },
  });
  if (!employee) throw new Error("Employee not found");

  const unitPrice = Number(item.sellPrice);
  const totalAmount = unitPrice * input.quantity;
  const commissionAmount = totalAmount * Number(employee.commissionRate);

  return prisma.$transaction(async (tx: any) => {
    // الكمية بتنقص بشرط إنها لسه كفاية (بيعين في نفس اللحظة مايخلّوش المخزون بالسالب)
    const dec = await tx.inventoryItem.updateMany({
      where: { id: item.id, quantity: { gte: input.quantity } },
      data: { quantity: { decrement: input.quantity } },
    });
    if (dec.count === 0) throw new Error("Insufficient stock");
    await tx.inventoryMovement.create({
      data: { itemId: item.id, type: "OUT", quantity: input.quantity, reason: `Sale by employee ${employee.name}` },
    });
    // 4. قيد البيع في الدفاتر: مدين الخزنة / دائن المبيعات (على فرع البيع) - عشان
    // الأرباح والخسائر والميزانية العمومية يشوفوا مبيعات المحل مش الفواتير بس
    const [cash, revenue] = await Promise.all([
      getOrCreateAccount(tx, input.tenantId, "1000", "Cash", "ASSET"),
      getOrCreateAccount(tx, input.tenantId, "4000", "Sales Revenue", "REVENUE"),
    ]);
    const entry = await tx.journalEntry.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        description: `Sale — ${item.name} × ${input.quantity}`,
        lines: { create: [{ accountId: cash.id, debit: totalAmount }, { accountId: revenue.id, credit: totalAmount }] },
      },
    });
    return tx.sale.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        employeeId: input.employeeId,
        customerId: input.customerId,
        itemId: input.itemId,
        quantity: input.quantity,
        unitPrice,
        totalAmount,
        commissionAmount,
        journalEntryId: entry.id,
      },
      include: { employee: true, item: true, customer: true },
    });
  });
}
