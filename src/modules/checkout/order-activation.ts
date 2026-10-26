import { prisma } from "../../config/db";
import { computeExpiryDate } from "../../utils/modules";
import { createLinkedCompany } from "../tenants/company-creation.service";
import { createNotification } from "../notifications/notifications.service";
import { checkPlatformInvoice } from "./myfatoorah";
import { container } from "../../core/container";
import { grantIncludedAiCredits } from "../ai/ai-subscription";
import { getPlatformConfig } from "../../utils/platform-config";

// تفعيل طلب اشتراك: بيتنادى أوتوماتيك أول ما الدفع يتأكد من MyFatoorah، أو
// يدويًا من السوبر أدمن (طلبات اتدفعت بره البوابة مثلًا). نفس المنطق للاتنين
export async function activateSubscriptionOrder(orderId: string) {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: orderId }, include: { tenant: { include: { users: true } } } });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCELLED") throw new Error("This order was cancelled");
  if (order.status === "ACTIVATED") return { ok: true as const, alreadyActive: true };

  // طلب "شركة إضافية" - الشركة الجديدة بتتعمل هنا بس (بعد الدفع)، مش وقت الطلب
  if (order.orderType === "EXTRA_COMPANY") {
    if (!order.extraCompanyName || !order.extraCompanyIndustry) throw new Error("This order is missing the new company's name/industry");
    const owner = order.tenant.users.find((u: (typeof order.tenant.users)[number]) => u.role === "OWNER" && !u.isLinkedCompany);
    if (!owner) throw new Error("Couldn't find the account owner to link the new company to");
    // نقفل الطلب الأول (ACTIVATED) عشان طلبين في نفس اللحظة مايعملوش شركتين
    const claimed = await prisma.subscriptionOrder.updateMany({ where: { id: order.id, status: { in: ["PENDING", "PAID"] } }, data: { status: "ACTIVATED" } });
    if (claimed.count === 0) return { ok: true as const, alreadyActive: true };
    const newTenant = await createLinkedCompany(owner.id, order.extraCompanyName, order.extraCompanyIndustry);
    if (order.selectedModules.length > 0) {
      const expiry = computeExpiryDate(order.billingCycle).toISOString();
      await prisma.tenant.update({
        where: { id: newTenant.id },
        data: { subscribedModules: order.selectedModules, moduleExpirations: Object.fromEntries(order.selectedModules.map((m: string) => [m, expiry])) },
      });
      if (order.selectedModules.includes("ai")) await grantIncludedAiCredits(container.creditService, newTenant.id, order.billingCycle, order.id, await getPlatformConfig());
    }
    await createNotification({ tenantId: order.tenantId, type: "SUBSCRIPTION_ACTIVATED", title: "Your new company is ready", body: `${newTenant.name} has been created and its services are active.`, link: "/dashboard" }).catch(() => {});
    return { ok: true as const, createdTenantId: newTenant.id, createdTenantName: newTenant.name };
  }

  const tenant = order.tenant;
  const merged = Array.from(new Set([...tenant.subscribedModules, ...order.selectedModules]));
  // لو الموديول عنده اشتراك لسه شغال، بنمدّ من تاريخ انتهائه (مفيش ضياع مدة)
  const existingExpirations = (tenant.moduleExpirations as Record<string, string>) ?? {};
  const nextExpirations: Record<string, string> = { ...existingExpirations };
  for (const moduleId of order.selectedModules) {
    const currentExpiry = existingExpirations[moduleId] ? new Date(existingExpirations[moduleId]) : null;
    const startFrom = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
    nextExpirations[moduleId] = computeExpiryDate(order.billingCycle, startFrom).toISOString();
  }
  const done = await prisma.$transaction(async (tx: any) => {
    const claimed = await tx.subscriptionOrder.updateMany({ where: { id: order.id, status: { in: ["PENDING", "PAID"] } }, data: { status: "ACTIVATED" } });
    if (claimed.count === 0) return false;
    await tx.tenant.update({ where: { id: tenant.id }, data: { subscribedModules: merged, moduleExpirations: nextExpirations } });
    return true;
  });
  if (!done) return { ok: true as const, alreadyActive: true };
  if (order.selectedModules.includes("ai")) await grantIncludedAiCredits(container.creditService, tenant.id, order.billingCycle, order.id, await getPlatformConfig());
  await createNotification({ tenantId: tenant.id, type: "SUBSCRIPTION_ACTIVATED", title: "Your services are active", body: `Activated: ${order.selectedModules.join(", ")}. Thank you!`, link: "/dashboard" }).catch(() => {});
  return { ok: true as const, subscribedModules: merged, moduleExpirations: nextExpirations };
}

// بنسأل MyFatoorah عن فاتورة الطلب نفسها (برقمها)، ولو اتدفعت: PAID + تفعيل على
// طول. ده اللي بيشتغل لوحده كل دقيقتين (jobs/payment-sync.ts) ومن زرار
// "Check payment" في السوبر أدمن - من غير ما يعتمد إن العميل رجع للموقع
export async function syncOrderPayment(orderId: string) {
  const order = await prisma.subscriptionOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Order not found");
  if (!order.myFatoorahInvoiceId) return { status: order.status, gateway: "no MyFatoorah invoice on this order" };
  if (order.status !== "PENDING" && order.status !== "PAID") return { status: order.status, gateway: "already handled" };
  const check = await checkPlatformInvoice(order.myFatoorahInvoiceId);
  if (check.error && !check.status) return { status: order.status, gateway: check.error };
  // الرد لازم يكون عن نفس الفاتورة
  if (check.invoiceId && check.invoiceId !== String(order.myFatoorahInvoiceId)) return { status: order.status, gateway: "MyFatoorah answered about a different invoice" };
  if (!check.paid) return { status: order.status, gateway: check.status || "unknown" };
  if (order.status === "PENDING") {
    await prisma.subscriptionOrder.updateMany({
      where: { id: order.id, status: "PENDING" },
      data: { status: "PAID", ...(check.paymentId ? { myFatoorahPaymentId: check.paymentId } : {}) },
    });
  }
  await activateSubscriptionOrder(order.id);
  return { status: "ACTIVATED", gateway: check.status };
}
