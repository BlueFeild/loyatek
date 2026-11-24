import { prisma } from "../../config/db";
import type { Prisma } from "@prisma/client";
import { assertItemsInBranch, assertTenantOwns } from "../../utils/tenant-owned";

interface CreatePOInput {
  tenantId: string;
  branchId: string;
  supplierId: string;
  items: { itemId: string; quantity: number; unitCost: number }[];
}

// إنشاء أمر شراء بحالة DRAFT - لسه ما اتحدثش المخزون
export async function createPurchaseOrder(input: CreatePOInput) {
  // الفرع والمورد وكل الأصناف لازم يكونوا تبع نفس الشركة
  await assertTenantOwns(input.tenantId, {
    branchIds: [input.branchId],
    supplierIds: [input.supplierId],
    itemIds: input.items.map((i) => i.itemId),
  });
  await assertItemsInBranch(input.tenantId, input.branchId, input.items.map((i) => i.itemId));
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
  // أوامر قديمة (قبل التحقق) ممكن يكون فيها صنف من شركة تانية - منزوّدش مخزون حد تاني
  await assertTenantOwns(tenantId, { itemIds: po.items.map((i: { itemId: string }) => i.itemId) });

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // claim ذري: الاستلام المتزامن لنفس الأمر كان بيزوّد المخزون أكتر من مرة
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: po.id, tenantId, status: { notIn: ["RECEIVED", "CANCELLED"] } },
      data: { status: "RECEIVED", receivedAt: new Date(), dueDate },
    });
    if (claimed.count === 0) throw new Error("Purchase order already received");
    for (const item of po.items as { itemId: string; quantity: number }[]) {
      await tx.inventoryItem.updateMany({
        where: { id: item.itemId, tenantId },
        data: { quantity: { increment: item.quantity } },
      });
      await tx.inventoryMovement.create({
        data: { itemId: item.itemId, type: "IN", quantity: item.quantity, reason: `Purchase order ${po.id} received` },
      });
    }
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  });
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
