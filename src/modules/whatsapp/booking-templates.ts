import { prisma } from "../../config/db";
import {
  createWhatsappTemplate,
  findWhatsappTemplateByName,
  getOrCreateWhatsappSettings,
  getWhatsappTemplateStatus,
  recordWhatsappMessage,
  sendWhatsappTemplate,
} from "./whatsapp.service";

// قوالب الحجز الجاهزة اللي بتتبعت لـ Meta تتعتمد (UTILITY). بعد الاعتماد
// الرسايل دي بتوصل لأي رقم - من غير شرط إن العميل كلّم البيزنس آخر 24 ساعة
export const BOOKING_TEMPLATE_PURPOSES = ["BOOKING_CONFIRMATION", "BOOKING_MERCHANT_ALERT", "BOOKING_REMINDER"] as const;
export type BookingTemplatePurpose = (typeof BOOKING_TEMPLATE_PURPOSES)[number];
export const ORDER_TEMPLATE_PURPOSES = ["ORDER_RECEIVED", "ORDER_READY"] as const;
export type OrderTemplatePurpose = (typeof ORDER_TEMPLATE_PURPOSES)[number];
export type ManagedTemplatePurpose = BookingTemplatePurpose | OrderTemplatePurpose;
export type TemplateLang = "en" | "ar";

interface TemplateDef {
  name: string;
  // ترتيب المتغيرات {{1}} {{2}} ... (أسماء القيم اللي بنملاها وقت الإرسال)
  params: string[];
  body: Record<TemplateLang, string>;
  example: string[];
}

// Meta بترفض متغير في أول أو آخر النص - كل قالب بيبدأ وبيخلص بكلام.
// رسايل احترافية فيها كل التفاصيل (الخدمة، الميعاد، مع مين، رقم الحجز).
// الأسماء اتغيرت (نسخة 3 - نص العميل) عشان Meta مابتسمحش بتعديل قالب اتبعت قبل كده
export const BOOKING_TEMPLATES: Record<BookingTemplatePurpose, TemplateDef> = {
  BOOKING_CONFIRMATION: {
    name: "bf_booking_request_received",
    params: ["customer_name", "provider_name", "service_type", "date", "time", "provider_name", "provider_phone"],
    body: {
      en: `🔔 Booking Request Received!

Hi {{1}},
Thank you for booking with us! Your request has been sent to {{2}}.

📋 Booking Details:
• Service: {{3}}
• Date: {{4}}
• Time: {{5}}
• Provider: {{6}}

📞 Need assistance? Contact the provider directly at: {{7}}

We look forward to serving you! ✨`,
      ar: `🔔 تم استلام طلب الحجز!

أهلًا {{1}}،
شكرًا لحجزك معنا! تم إرسال طلبك إلى {{2}}.

📋 تفاصيل الحجز:
• الخدمة: {{3}}
• التاريخ: {{4}}
• الوقت: {{5}}
• مقدم الخدمة: {{6}}

📞 محتاج مساعدة؟ تواصل مع مقدم الخدمة مباشرة على: {{7}}

في انتظارك! ✨`,
    },
    example: ["Fatima", "Glow Salon", "Haircut & Styling", "17/10/2026", "16:00", "Glow Salon", "+97455512345"],
  },
  BOOKING_MERCHANT_ALERT: {
    name: "bf_new_booking_notification",
    params: ["provider_name", "customer_name", "phone", "service_type", "date", "time"],
    body: {
      en: `🔔 New Booking Notification

Hi {{1}},
You have received a new booking through the platform. Here are the details:

👤 Customer Name: {{2}}

📞 Contact Number: {{3}}

🛠️ Requested Service: {{4}}

📅 Date: {{5}}

⏰ Time: {{6}}

📌 Please review your dashboard to manage or confirm this request`,
      ar: `🔔 إشعار حجز جديد

أهلًا {{1}}،
وصلك حجز جديد من خلال المنصة. دي التفاصيل:

👤 اسم العميل: {{2}}

📞 رقم التواصل: {{3}}

🛠️ الخدمة المطلوبة: {{4}}

📅 التاريخ: {{5}}

⏰ الوقت: {{6}}

📌 راجع لوحة التحكم عشان تدير الطلب أو تأكده`,
    },
    example: ["Glow Salon", "Fatima", "+97455512345", "Haircut & Styling", "17/10/2026", "16:00"],
  },
  BOOKING_REMINDER: {
    name: "bf_appointment_reminder",
    params: ["name", "business", "services", "date", "time", "resource"],
    body: {
      en: `Reminder ⏰ Hi {{1}}, this is a friendly reminder of your appointment at {{2}}.

🔹 Service: {{3}}
📅 Date: {{4}}
⏰ Time: {{5}}
👤 With: {{6}}

Need to change it? Simply reply to this message. See you soon!`,
      ar: `تذكير ⏰ أهلًا {{1}}، بنفكّرك بموعدك في {{2}}.

🔹 الخدمة: {{3}}
📅 التاريخ: {{4}}
⏰ الوقت: {{5}}
👤 مع: {{6}}

لو حابب تغيّره، رد على هذه الرسالة. في انتظارك!`,
    },
    example: ["Fatima", "Glow Salon", "Haircut & Styling", "17/10/2026", "16:00", "Sara"],
  },
};

// قوالب الأوردرات (المنيو): تأكيد استلام الطلب + "طلبك جاهز"
export const ORDER_TEMPLATES: Record<OrderTemplatePurpose, TemplateDef> = {
  ORDER_RECEIVED: {
    name: "bf_order_received",
    params: ["customer_name", "business", "items", "total", "mode"],
    body: {
      en: `🧾 Order Received!

Hi {{1}},
Thank you for your order from {{2}}.

📦 Items: {{3}}
💰 Total: {{4}}
📍 Order type: {{5}}

We are preparing it now. Thank you!`,
      ar: `🧾 تم استلام طلبك!

أهلًا {{1}}،
شكرًا لطلبك من {{2}}.

📦 الأصناف: {{3}}
💰 الإجمالي: {{4}}
📍 نوع الطلب: {{5}}

جاري تجهيز طلبك الآن. شكرًا لك!`,
    },
    example: ["Fatima", "Glow Cafe", "2× Latte, 1× Croissant", "QAR 45.00", "Pickup"],
  },
  ORDER_READY: {
    name: "bf_order_ready",
    params: ["customer_name", "business", "reference", "mode"],
    body: {
      en: `✅ Your order is ready!

Hi {{1}},
Your order from {{2}} is ready.

🧾 Order number: {{3}}
📍 Order type: {{4}}

Thank you for choosing us!`,
      ar: `✅ طلبك جاهز!

أهلًا {{1}}،
طلبك من {{2}} جاهز الآن.

🧾 رقم الطلب: {{3}}
📍 نوع الطلب: {{4}}

شكرًا لاختيارك لنا!`,
    },
    example: ["Fatima", "Glow Cafe", "A1B2C3", "Pickup"],
  },
};

const MANAGED_TEMPLATES: Record<ManagedTemplatePurpose, TemplateDef> = { ...BOOKING_TEMPLATES, ...ORDER_TEMPLATES };

export function templateName(purpose: ManagedTemplatePurpose, lang: TemplateLang) {
  return `${MANAGED_TEMPLATES[purpose].name}_${lang}`;
}

// القيم بالترتيب اللي القالب مستنيه
export function templateParams(purpose: ManagedTemplatePurpose, values: Record<string, string>): string[] {
  return MANAGED_TEMPLATES[purpose].params.map((p) => values[p] ?? "");
}

// النص النهائي (للسجل في Team Inbox) - نفس اللي العميل هيشوفه
export function renderTemplateBody(purpose: ManagedTemplatePurpose, lang: TemplateLang, params: string[]) {
  return MANAGED_TEMPLATES[purpose].body[lang].replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
}

export function ensureBookingTemplates(tenantId: string, lang: TemplateLang) {
  return ensureTemplates(tenantId, lang, BOOKING_TEMPLATE_PURPOSES);
}

export function ensureOrderTemplates(tenantId: string, lang: TemplateLang) {
  return ensureTemplates(tenantId, lang, ORDER_TEMPLATE_PURPOSES);
}

// بيبعت القوالب لـ Meta (اللي مش موجود منها بس) ويسجّلها PENDING
async function ensureTemplates(tenantId: string, lang: TemplateLang, purposes: readonly ManagedTemplatePurpose[]) {
  const settings = await getOrCreateWhatsappSettings(tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaWabaId) {
    throw new Error("Connect WhatsApp (with your WABA ID) and press “Verify connection” first.");
  }
  const results: { purpose: ManagedTemplatePurpose; name: string; status: string; error?: string }[] = [];
  for (const purpose of purposes) {
    const name = templateName(purpose, lang);
    const existing = await prisma.whatsappTemplate.findFirst({ where: { tenantId, name } });
    if (existing && existing.status !== "REJECTED") {
      results.push({ purpose, name, status: existing.status });
      continue;
    }
    const def = MANAGED_TEMPLATES[purpose];
    let metaTemplateId: string | undefined;
    let status = "PENDING";
    const created = await createWhatsappTemplate(settings.metaAccessToken, settings.metaWabaId, {
      name,
      language: lang,
      category: "UTILITY",
      bodyText: def.body[lang],
      bodyExamples: def.example,
    });
    if (created.ok) {
      metaTemplateId = created.metaTemplateId;
    } else {
      // القالب ممكن يكون اتعمل قبل كده عند Meta - بنربطه بدل ما نفشل
      const found = await findWhatsappTemplateByName(settings.metaAccessToken, settings.metaWabaId, name, lang);
      if (!found) {
        results.push({ purpose, name, status: "ERROR", error: created.error });
        continue;
      }
      metaTemplateId = found.id;
      status = found.status === "APPROVED" ? "APPROVED" : found.status === "REJECTED" ? "REJECTED" : "PENDING";
    }
    const data = {
      tenantId,
      settingsId: settings.id,
      name,
      language: lang,
      category: "UTILITY",
      bodyText: def.body[lang],
      metaTemplateId,
      status: status as "PENDING" | "APPROVED" | "REJECTED",
      rejectionReason: null,
      purpose,
    };
    if (existing) await prisma.whatsappTemplate.update({ where: { id: existing.id }, data });
    else await prisma.whatsappTemplate.create({ data });
    results.push({ purpose, name, status });
  }
  return results;
}

// القالب المعتمد لغرض معيّن. لو لسه PENDING بنسأل Meta عن حالته (مرة كل ما
// نحتاجه) - عشان أول ما يتعتمد يبدأ يتبعت من غير ما حد يدوس حاجة
export async function getApprovedBookingTemplate(tenantId: string, purpose: ManagedTemplatePurpose, lang: TemplateLang) {
  const tpl = await prisma.whatsappTemplate.findFirst({ where: { tenantId, name: templateName(purpose, lang) } });
  if (!tpl) return null;
  if (tpl.status === "APPROVED") return tpl;
  if (tpl.status === "PENDING" && tpl.metaTemplateId) {
    const settings = await getOrCreateWhatsappSettings(tenantId);
    if (!settings.metaAccessToken) return null;
    const check = await getWhatsappTemplateStatus(settings.metaAccessToken, tpl.metaTemplateId);
    if (check.ok && (check.status === "APPROVED" || check.status === "REJECTED")) {
      const updated = await prisma.whatsappTemplate.update({
        where: { id: tpl.id },
        data: { status: check.status, rejectionReason: check.rejectionReason ?? null },
      });
      return updated.status === "APPROVED" ? updated : null;
    }
  }
  return null;
}

// إرسال رسالة حجز بالقالب المعتمد (لو موجود) وتسجيلها في Team Inbox.
// بيرجّع null لو مفيش قالب معتمد - اللي استدعاها يقرر يبعت نص حر بداله
export async function sendBookingTemplate(
  tenantId: string,
  purpose: ManagedTemplatePurpose,
  lang: TemplateLang,
  to: string,
  values: Record<string, string>,
  contactName?: string
): Promise<{ ok: boolean; error?: string } | null> {
  const tpl = await getApprovedBookingTemplate(tenantId, purpose, lang);
  if (!tpl) return null;
  const settings = await getOrCreateWhatsappSettings(tenantId);
  if (!settings.metaAccessToken || !settings.metaPhoneNumberId) return null;
  const params = templateParams(purpose, values);
  const phone = to.replace(/[^\d]/g, "");
  const result = await sendWhatsappTemplate(settings.metaAccessToken, settings.metaPhoneNumberId, phone, tpl.name, tpl.language, params);
  await recordWhatsappMessage({
    tenantId,
    direction: "OUT",
    contactPhone: phone,
    contactName,
    body: renderTemplateBody(purpose, lang, params),
    kind: "template",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
  return result;
}
