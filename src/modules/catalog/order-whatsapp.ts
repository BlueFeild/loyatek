import { prisma } from "../../config/db";
import { shortReference } from "../payment-settings/payment-methods";
import { renderTemplateBody, sendBookingTemplate, templateParams, type TemplateLang } from "../whatsapp/booking-templates";
import { getOrCreateWhatsappSettings, recordWhatsappMessage, sendWhatsappTextMessage } from "../whatsapp/whatsapp.service";
import type { OrderReadyNotifier, ReadyNotifyResult, ReadyOrder } from "./order-ready.types";

// Meta بترفض سطور جديدة أو مسافات كتير جوه متغيرات القالب
export function templateValue(value: string, max = 200) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function orderModeText(order: { mode: string; tableLabel: string | null }, lang: TemplateLang) {
  if (order.mode === "DINE_IN") {
    if (!order.tableLabel) return lang === "ar" ? "داخل المكان" : "Dine-in";
    return `${lang === "ar" ? "طاولة" : "Table"} ${order.tableLabel}`;
  }
  return lang === "ar" ? "استلام" : "Pickup";
}

// لغة قوالب الأوردرات واسم النشاط اللي بيظهر للعميل
async function orderMessageContext(tenantId: string): Promise<{ lang: TemplateLang; business: string }> {
  const [settings, tenant] = await Promise.all([
    prisma.catalogSettings.findUnique({ where: { tenantId }, select: { waTemplateLang: true, brandName: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return { lang: settings?.waTemplateLang === "ar" ? "ar" : "en", business: templateValue(settings?.brandName || tenant?.name || "") };
}

// تأكيد استلام الطلب بالقالب المعتمد. null = مفيش قالب معتمد (يتبعت نص التاجر بداله)
export async function sendOrderReceivedTemplate(
  order: { tenantId: string; customerName: string; customerPhone: string; mode: string; tableLabel: string | null; items: { name?: string; quantity?: number }[] },
  total: string
) {
  const { lang, business } = await orderMessageContext(order.tenantId);
  const separator = lang === "ar" ? "، " : ", ";
  return sendBookingTemplate(
    order.tenantId,
    "ORDER_RECEIVED",
    lang,
    order.customerPhone,
    {
      customer_name: templateValue(order.customerName),
      business,
      items: templateValue(order.items.map((i) => `${i.quantity ?? 1}× ${i.name ?? ""}`).join(separator), 900),
      total,
      mode: orderModeText(order, lang),
    },
    order.customerName
  );
}

export class WhatsappOrderReadyNotifier implements OrderReadyNotifier {
  async send(order: ReadyOrder): Promise<ReadyNotifyResult> {
    const wa = await getOrCreateWhatsappSettings(order.tenantId);
    if (!(wa.isConnected && wa.metaAccessToken && wa.metaPhoneNumberId)) return { state: "not_connected" };

    const { lang, business } = await orderMessageContext(order.tenantId);
    const values = {
      customer_name: templateValue(order.customerName),
      business,
      reference: shortReference(order.id),
      mode: orderModeText(order, lang),
    };
    const viaTemplate = await sendBookingTemplate(order.tenantId, "ORDER_READY", lang, order.customerPhone, values, order.customerName);
    if (viaTemplate) return viaTemplate.ok ? { state: "template" } : { state: "failed", error: viaTemplate.error ?? "Meta rejected the message" };

    // لسه مفيش قالب معتمد: نص عادي - Meta بتوصله بس لو العميل كلّم التاجر آخر 24 ساعة
    const phone = order.customerPhone.replace(/[^\d]/g, "");
    const body = renderTemplateBody("ORDER_READY", lang, templateParams("ORDER_READY", values));
    const sent = await sendWhatsappTextMessage(wa.metaAccessToken, wa.metaPhoneNumberId, phone, body);
    await recordWhatsappMessage({
      tenantId: order.tenantId,
      direction: "OUT",
      contactPhone: phone,
      contactName: order.customerName,
      body,
      kind: "text",
      waMessageId: sent.messageId,
      status: sent.ok ? "sent" : "failed",
      error: sent.ok ? null : sent.error,
    });
    return sent.ok ? { state: "text" } : { state: "failed", error: sent.error ?? "Meta rejected the message" };
  }
}
