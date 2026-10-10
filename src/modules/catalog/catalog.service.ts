import { prisma } from "../../config/db";
import { getOrCreateWhatsappSettings, sendWhatsappTextMessage } from "../whatsapp/whatsapp.service";
import { renderMessageTemplate } from "../../utils/messageTemplate";
import { createNotification } from "../notifications/notifications.service";
import { initiateTenantPayment, checkTenantMyFatoorahPaymentStatus } from "../checkout/myfatoorah";

export async function getOrCreateCatalogSettings(tenantId: string) {
  const existing = await prisma.catalogSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.catalogSettings.create({ data: { tenantId } });
}

interface UpdateCatalogSettingsInput {
  brandName?: string;
  brandLogoDataUrl?: string | null;
  menuLayout?: string;
  dineInEnabled?: boolean;
  pickupEnabled?: boolean;
  tableNames?: string[];
  merchantEmail?: string;
  kitchenWhatsapp?: string;
  prepTime?: number;
  themeColor?: string;
  paymentRequired?: boolean;
  posLink?: string;
  waMerchantTemplate?: string;
  waCustomerTemplate?: string;
}

export async function updateCatalogSettings(tenantId: string, data: UpdateCatalogSettingsInput) {
  await getOrCreateCatalogSettings(tenantId);
  return prisma.catalogSettings.update({ where: { tenantId }, data });
}

interface OrderItemInput {
  menuItemId: string;
  quantity: number;
}

interface CreateOrderInput {
  tenantId: string;
  branchId: string;
  mode: "DINE_IN" | "PICKUP";
  tableLabel?: string;
  readyTime?: number;
  customerName: string;
  customerPhone: string;
  items: OrderItemInput[];
  redirectionUrlBase?: string;
}

// إشعار داخلي حقيقي للمطعم إن أوردر جديد وصل - بيظهر فورًا لو الدفع مش
// مفعّل، أو بس بعد ما الدفع الحقيقي يتأكد لو مفعّل (عشان المطبخ ميبدأش
// يجهّز أوردر لسه ما اتدفعش)
async function notifyNewOrder(order: { id: string; customerName: string; customerPhone?: string | null; mode: string; tableLabel: string | null; totalAmount: any; items: { id: string; name?: string; quantity?: number }[] }, tenantId: string) {
  const modeLabel = order.mode === "DINE_IN" ? (order.tableLabel ? `Table ${order.tableLabel}` : "Dine-in") : "Pickup";
  await createNotification({
    tenantId,
    type: "CATALOG_ORDER",
    title: "New order received",
    body: `${order.customerName} — ${modeLabel} — ${order.items.length} item(s) — ${Number(order.totalAmount).toFixed(2)}`,
    link: "/catalog",
  });

  // رسائل واتساب بالنص اللي كتبه التاجر (للمطبخ وللعميل) - best effort،
  // فشلها مايوقفش الأوردر
  try {
    const [settings, wa] = await Promise.all([getOrCreateCatalogSettings(tenantId), getOrCreateWhatsappSettings(tenantId)]);
    if (!(wa.isConnected && wa.metaAccessToken && wa.metaPhoneNumberId)) return;
    const vars = {
      name: order.customerName,
      mode: modeLabel,
      items: order.items.map((i) => `${i.quantity ?? 1}× ${i.name ?? ""}`).join("\n"),
      total: Number(order.totalAmount).toFixed(2),
      prep: settings.prepTime,
    };
    const digits = (v: string) => v.replace(/[^\d]/g, "");
    if (settings.kitchenWhatsapp && settings.waMerchantTemplate.trim()) {
      await sendWhatsappTextMessage(wa.metaAccessToken, wa.metaPhoneNumberId, digits(settings.kitchenWhatsapp), renderMessageTemplate(settings.waMerchantTemplate, vars));
    }
    if (order.customerPhone && settings.waCustomerTemplate.trim()) {
      await sendWhatsappTextMessage(wa.metaAccessToken, wa.metaPhoneNumberId, digits(order.customerPhone), renderMessageTemplate(settings.waCustomerTemplate, vars));
    }
  } catch {
    // ignore
  }
}

// إنشاء طلب حقيقي - بياخد أسعار الأصناف الحقيقية من قاعدة البيانات وقت
// الطلب (مش من الفرونت إند)، عشان محدش يقدر يغيّر السعر من عنده
export async function createOrder(input: CreateOrderInput) {
  const [menuItems, settings] = await Promise.all([
    prisma.menuItem.findMany({
      where: { tenantId: input.tenantId, id: { in: input.items.map((i) => i.menuItemId) } },
    }),
    getOrCreateCatalogSettings(input.tenantId),
  ]);

  if (menuItems.length !== input.items.length) {
    throw new Error("One or more menu items were not found");
  }

  const lines = input.items.map((line) => {
    const item = menuItems.find((m: (typeof menuItems)[number]) => m.id === line.menuItemId)!;
    return { menuItemId: item.id, name: item.name, price: item.price, quantity: line.quantity };
  });

  const totalAmount = lines.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);

  const order = await prisma.catalogOrder.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      mode: input.mode,
      tableLabel: input.tableLabel,
      readyTime: input.readyTime,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      totalAmount,
      paymentStatus: settings.paymentRequired ? "AWAITING_PAYMENT" : "NOT_REQUIRED",
      items: { create: lines },
    },
    include: { items: true },
  });

  // من غير دفع - نفس السلوك القديم بالظبط، إشعار فوري للمطبخ
  if (!settings.paymentRequired) {
    await notifyNewOrder(order, input.tenantId);
    return { ...order, paymentUrl: null, paymentError: null };
  }

  // الدفع مفعّل - الأوردر محفوظ فعليًا بحالة AWAITING_PAYMENT، وميوصلش
  // إشعار للمطبخ إلا بعد ما الدفع الحقيقي ينجح
  const payment = await initiateTenantPayment(input.tenantId, {
    amount: totalAmount,
    redirectionUrl: `${input.redirectionUrlBase ?? ""}?orderId=${order.id}`,
    reference: order.id,
  });

  if (!payment.ok) {
    return { ...order, paymentUrl: null, paymentError: payment.error };
  }

  const updated = await prisma.catalogOrder.update({
    where: { id: order.id },
    data: { myFatoorahInvoiceId: payment.invoiceId, myFatoorahPaymentUrl: payment.paymentUrl },
    include: { items: true },
  });

  return { ...updated, paymentUrl: payment.paymentUrl, paymentError: null };
}

// بيتأكد من حالة دفع أوردر حقيقي بالسؤال المباشر لـ MyFatoorah (بمفتاح
// التاجر)، ولو نجح فعليًا بيبعت إشعار المطبخ - أول مرة بس
export async function confirmOrderPaymentIfPaid(orderId: string, paymentId: string) {
  const order = await prisma.catalogOrder.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw new Error("Order not found");

  if (order.paymentStatus !== "AWAITING_PAYMENT") return order;

  const check = await checkTenantMyFatoorahPaymentStatus(order.tenantId, paymentId);
  if (!check.paid) return order;

  const updated = await prisma.catalogOrder.update({
    where: { id: order.id },
    data: { paymentStatus: "PAID", myFatoorahPaymentId: paymentId },
    include: { items: true },
  });

  await notifyNewOrder(updated, updated.tenantId);
  return updated;
}

// التاجر بيأكد يدويًا إن العميل دفع (لو بيستخدم لينك دفع من مزوّد تاني)
export async function markOrderPaidManually(tenantId: string, orderId: string) {
  const order = await prisma.catalogOrder.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
  if (!order) throw new Error("Order not found");
  if (order.paymentStatus === "PAID") return order;
  if (order.paymentStatus !== "AWAITING_PAYMENT") throw new Error("This order isn't waiting for payment");
  const updated = await prisma.catalogOrder.update({ where: { id: order.id }, data: { paymentStatus: "PAID" }, include: { items: true } });
  await notifyNewOrder(updated, updated.tenantId);
  return updated;
}
