import { prisma } from "../../config/db";

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
export async function recordSale(input: RecordSaleInput) {
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

  const [, , sale] = await prisma.$transaction([
    prisma.inventoryItem.update({
      where: { id: item.id },
      data: { quantity: { decrement: input.quantity } },
    }),
    prisma.inventoryMovement.create({
      data: {
        itemId: item.id,
        type: "OUT",
        quantity: input.quantity,
        reason: `Sale by employee ${employee.name}`,
      },
    }),
    prisma.sale.create({
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
      },
      include: { employee: true, item: true, customer: true },
    }),
  ]);

  return sale;
}
