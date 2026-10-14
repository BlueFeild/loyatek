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
export type TemplateLang = "en" | "ar";

interface TemplateDef {
  name: string;
  // ترتيب المتغيرات {{1}} {{2}} ... (أسماء القيم اللي بنملاها وقت الإرسال)
  params: string[];
  body: Record<TemplateLang, string>;
  example: string[];
}

// Meta بترفض متغير في أول أو آخر النص - كل قالب بيبدأ وبيخلص بكلام
export const BOOKING_TEMPLATES: Record<BookingTemplatePurpose, TemplateDef> = {
  BOOKING_CONFIRMATION: {
    name: "bf_booking_confirmation",
    params: ["name", "business", "date", "time"],
    body: {
      en: "Hello {{1}}, your booking at {{2}} is confirmed for {{3}} at {{4}}. Reply to this message if you need to change it.",
      ar: "مرحبًا {{1}}، تم تأكيد حجزك في {{2}} يوم {{3}} الساعة {{4}}. للتعديل رد على هذه الرسالة.",
    },
    example: ["Fatima", "Glow Salon", "17/10/2026", "16:00"],
  },
  BOOKING_MERCHANT_ALERT: {
    name: "bf_booking_alert",
    params: ["business", "name", "phone", "resource", "date", "time"],
    body: {
      en: "New booking at {{1}}: {{2}} ({{3}}) booked {{4}} on {{5}} at {{6}}. Open your dashboard for details.",
      ar: "حجز جديد في {{1}}: {{2}} ({{3}}) حجز {{4}} يوم {{5}} الساعة {{6}}. التفاصيل في لوحة التحكم.",
    },
    example: ["Glow Salon", "Fatima", "97455512345", "Sara", "17/10/2026", "16:00"],
  },
  BOOKING_REMINDER: {
    name: "bf_booking_reminder",
    params: ["name", "business", "date", "time"],
    body: {
      en: "Reminder: hi {{1}}, your appointment at {{2}} is on {{3}} at {{4}}. Reply to this message if you need to change it.",
      ar: "تذكير: أهلًا {{1}}، موعدك في {{2}} يوم {{3}} الساعة {{4}}. للتعديل رد على هذه الرسالة.",
    },
    example: ["Fatima", "Glow Salon", "17/10/2026", "16:00"],
  },
};

export function templateName(purpose: BookingTemplatePurpose, lang: TemplateLang) {
  return `${BOOKING_TEMPLATES[purpose].name}_${lang}`;
}

// القيم بالترتيب اللي القالب مستنيه
export function templateParams(purpose: BookingTemplatePurpose, values: Record<string, string>): string[] {
  return BOOKING_TEMPLATES[purpose].params.map((p) => values[p] ?? "");
}

// النص النهائي (للسجل في Team Inbox) - نفس اللي العميل هيشوفه
export function renderTemplateBody(purpose: BookingTemplatePurpose, lang: TemplateLang, params: string[]) {
  return BOOKING_TEMPLATES[purpose].body[lang].replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
}

// بيبعت القوالب التلاتة لـ Meta (اللي مش موجود منها بس) ويسجّلها PENDING
export async function ensureBookingTemplates(tenantId: string, lang: TemplateLang) {
  const settings = await getOrCreateWhatsappSettings(tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaWabaId) {
    throw new Error("Connect WhatsApp (with your WABA ID) and press “Verify connection” first.");
  }
  const results: { purpose: BookingTemplatePurpose; name: string; status: string; error?: string }[] = [];
  for (const purpose of BOOKING_TEMPLATE_PURPOSES) {
    const name = templateName(purpose, lang);
    const existing = await prisma.whatsappTemplate.findFirst({ where: { tenantId, name } });
    if (existing && existing.status !== "REJECTED") {
      results.push({ purpose, name, status: existing.status });
      continue;
    }
    const def = BOOKING_TEMPLATES[purpose];
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
export async function getApprovedBookingTemplate(tenantId: string, purpose: BookingTemplatePurpose, lang: TemplateLang) {
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
  purpose: BookingTemplatePurpose,
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
