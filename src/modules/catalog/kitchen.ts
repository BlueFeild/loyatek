import { prisma } from "../../config/db";
import { AppError, NotFoundError } from "../../core/errors";
import { confirmsOnOrder } from "../payment-settings/payment-methods";

// شاشة المطبخ + متابعة الطلب للعميل (2026-11-24).
// مراحل الطلب: جديد (preparingAt فاضي) ← بيتحضّر (preparingAt) ← جاهز (readyAt) ← اتسلّم (completedAt).
// "جاهز" نفسها بتمشي من OrderReadyService (عشان رسالة الواتساب للعميل).

export type KitchenStage = "new" | "preparing" | "ready" | "done" | "cancelled" | "waiting_payment";

interface StageFields {
  status: string;
  paymentStatus: string;
  paymentMethodType: string | null;
  preparingAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
}

// الطلب وصل المطبخ؟ من غير دفع، أو اتدفع، أو كاش (بيتجهّز قبل الدفع).
// التحويل البنكي ولينك الدفع وماي فاتورة: لسه مستنيين الدفع → المطبخ مايشوفهمش
export function reachedKitchen(o: Pick<StageFields, "paymentStatus" | "paymentMethodType">): boolean {
  return o.paymentStatus !== "AWAITING_PAYMENT" || confirmsOnOrder(o.paymentMethodType);
}

export function orderStage(o: StageFields): KitchenStage {
  if (o.status === "CANCELLED") return "cancelled";
  if (o.completedAt || o.status === "COMPLETED") return "done";
  if (!reachedKitchen(o)) return "waiting_payment";
  if (o.readyAt) return "ready";
  if (o.preparingAt) return "preparing";
  return "new";
}

// كود قصير للطلبات القديمة اللي مالهاش رقم (آخر 4 حروف من الـ id)
export function orderCode(o: { id: string; orderNumber: number | null }): string {
  return o.orderNumber ? String(o.orderNumber) : o.id.replace(/-/g, "").slice(-4).toUpperCase();
}

// الرقم الجاي للطلب - زيادة ذرية في صف الإعدادات (طلبين في نفس اللحظة ياخدوا رقمين مختلفين)
export async function nextOrderNumber(tenantId: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ orderSeq: number }[]>`
    UPDATE "catalog_settings" SET "orderSeq" = "orderSeq" + 1 WHERE "tenantId" = ${tenantId} RETURNING "orderSeq"`;
  return rows[0]?.orderSeq ?? null;
}

const KITCHEN_SELECT = {
  id: true,
  orderNumber: true,
  mode: true,
  tableLabel: true,
  readyTime: true,
  customerName: true,
  note: true,
  status: true,
  paymentStatus: true,
  paymentMethodType: true,
  paymentMethodLabel: true,
  preparingAt: true,
  readyAt: true,
  completedAt: true,
  readyNotify: true,
  createdAt: true,
  items: { select: { id: true, name: true, quantity: true } },
} as const;

// الطلبات اللي تظهر على شاشة المطبخ: آخر 24 ساعة، مش ملغية ولا اتسلّمت،
// والجاهز بيفضل ظاهر 3 ساعات (لحد ما يتسلّم)
export async function kitchenOrders(tenantId: string, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const readySince = new Date(now.getTime() - 3 * 3600_000);
  const rows = await prisma.catalogOrder.findMany({
    where: {
      tenantId,
      createdAt: { gte: since },
      status: { notIn: ["CANCELLED", "COMPLETED"] },
      completedAt: null,
      OR: [{ readyAt: null }, { readyAt: { gte: readySince } }],
    },
    select: KITCHEN_SELECT,
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return rows
    .filter(reachedKitchen)
    .map((o) => ({ ...o, code: orderCode(o), stage: orderStage(o) }));
}

type StageAction = "preparing" | "new" | "complete";

// تغيير المرحلة بشرط ذري (ضغطتين في نفس اللحظة من جهازين مايلخبطوش الطلب)
export async function setKitchenStage(tenantId: string, orderId: string, action: StageAction, now = new Date()) {
  const order = await prisma.catalogOrder.findFirst({ where: { id: orderId, tenantId }, select: KITCHEN_SELECT });
  if (!order) throw new NotFoundError("Order not found");
  if (order.status === "CANCELLED") throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled.");
  if (!reachedKitchen(order)) throw new AppError(409, "ORDER_NOT_PAID", "This order hasn't been paid yet.");

  if (action === "preparing") {
    await prisma.catalogOrder.updateMany({
      where: { id: orderId, tenantId, preparingAt: null, completedAt: null },
      data: { preparingAt: now, status: order.status === "PENDING" ? "CONFIRMED" : undefined },
    });
  } else if (action === "new") {
    // رجوع خطوة: من "بيتحضّر" لـ "جديد" بس (الجاهز اتبعتله رسالة خلاص)
    if (order.readyAt) throw new AppError(409, "ORDER_ALREADY_READY", "This order is already marked ready.");
    await prisma.catalogOrder.updateMany({ where: { id: orderId, tenantId, readyAt: null }, data: { preparingAt: null } });
  } else {
    await prisma.catalogOrder.updateMany({
      where: { id: orderId, tenantId, completedAt: null, status: { not: "CANCELLED" } },
      data: { completedAt: now, status: "COMPLETED", preparingAt: order.preparingAt ?? now },
    });
  }
  const fresh = await prisma.catalogOrder.findFirst({ where: { id: orderId, tenantId }, select: KITCHEN_SELECT });
  return fresh ? { ...fresh, code: orderCode(fresh), stage: orderStage(fresh) } : null;
}

// صفحة متابعة الطلب للعميل: اللي يلزمه بس (من غير رقم موبايل ولا روابط دفع)
export async function publicOrderStatus(tenantId: string, orderId: string, prepMinutes: number) {
  const o = await prisma.catalogOrder.findFirst({
    where: { id: orderId, tenantId },
    select: { ...KITCHEN_SELECT, totalAmount: true },
  });
  if (!o) return null;
  const stage = orderStage(o);
  const firstName = (o.customerName || "").trim().split(/\s+/)[0] || "";
  return {
    id: o.id,
    code: orderCode(o),
    stage,
    mode: o.mode,
    tableLabel: o.tableLabel,
    readyTime: o.readyTime,
    prepMinutes: o.mode === "PICKUP" && o.readyTime ? o.readyTime : prepMinutes,
    firstName,
    note: o.note,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
    totalAmount: o.totalAmount,
    paymentStatus: o.paymentStatus,
    paymentMethodLabel: o.paymentMethodLabel,
    createdAt: o.createdAt,
    preparingAt: o.preparingAt,
    readyAt: o.readyAt,
    completedAt: o.completedAt,
  };
}
