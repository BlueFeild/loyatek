import { prisma } from "../../config/db";

interface CreatePOInput {
  tenantId: string;
  branchId: string;
  supplierId: string;
  items: { itemId: string; quantity: number; unitCost: number }[];
}

// إنشاء أمر شراء بحالة DRAFT - لسه ما اتحدثش المخزون
export async function createPurchaseOrder(input: CreatePOInput) {
  return prisma.purchaseOrder.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      supplierId: input.supplierId,
      status: "DRAFT",
      items: {
        create: input.items.map((i) => ({
          itemId: i.itemId,
          quantity: i.quantity,
          unitCost: i.unitCost,
        })),
      },
    },
    include: { items: true, supplier: true },
  });
}

// تحديث حالة الأمر (مثلاً من DRAFT لـ ORDERED)
export async function updatePurchaseOrderStatus(
  tenantId: string,
  purchaseOrderId: string,
  status: "ORDERED" | "CANCELLED"
) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, tenantId },
  });
  if (!po) throw new Error("Purchase order not found");
  if (po.status !== "DRAFT") throw new Error(`Cannot move order from ${po.status} to ${status}`);

  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { status },
  });
}

// أهم عملية: تسلّم أمر الشراء فعليًا. ده بيعمل 3 حاجات سوا في transaction واحدة:
// 1. يزوّد كمية كل صنف بالكمية اللي وصلت
// 2. يسجّل حركة مخزون (IN) حقيقية لكل صنف (نفس منطق الـ Inventory module)
// 3. يغيّر حالة الأمر لـ RECEIVED علشان ميتسلمش مرتين بالغلط
export async function receivePurchaseOrder(tenantId: string, purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, tenantId },
    include: { items: true },
  });
  if (!po) throw new Error("Purchase order not found");
  if (po.status === "RECEIVED") throw new Error("Purchase order already received");
  if (po.status === "CANCELLED") throw new Error("Cannot receive a cancelled purchase order");

  const operations = po.items.flatMap((item: { itemId: string; quantity: number }) => [
    prisma.inventoryItem.update({
      where: { id: item.itemId },
      data: { quantity: { increment: item.quantity } },
    }),
    prisma.inventoryMovement.create({
      data: {
        itemId: item.itemId,
        type: "IN",
        quantity: item.quantity,
        reason: `Purchase order ${po.id} received`,
      },
    }),
  ]);

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const updatePoStatus = prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status: "RECEIVED", receivedAt: new Date(), dueDate },
  });

  const results = await prisma.$transaction([...operations, updatePoStatus]);
  return results[results.length - 1];
}

// تحديد أمر شراء كمدفوع - جزء من جدولة المستحقات (Accounts Payable)
export async function markPurchaseOrderPaid(tenantId: string, purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId } });
  if (!po) throw new Error("Purchase order not found");
  if (po.status !== "RECEIVED") throw new Error("Only received orders have a payable amount to settle");

  return prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { paymentStatus: "PAID" },
  });
}
