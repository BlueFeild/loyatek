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

// Meta بترفض متغير في أول أو آخر النص - كل قالب بيبدأ وبيخلص بكلام.
// رسايل احترافية فيها كل التفاصيل (الخدمة، الميعاد، مع مين، رقم الحجز).
// الأسماء اتغيرت (نسخة 2) عشان Meta مابتسمحش بتعديل قالب اتبعت قبل كده
export const BOOKING_TEMPLATES: Record<BookingTemplatePurpose, TemplateDef> = {
  BOOKING_CONFIRMATION: {
    name: "bf_booking_confirmed",
    params: ["name", "business", "services", "date", "time", "resource", "reference"],
    body: {
      en: `Hello {{1}}, your booking at {{2}} is confirmed ✅

🔹 Service: {{3}}
📅 Date: {{4}}
⏰ Time: {{5}}
👤 With: {{6}}
🔖 Booking ref: {{7}}

Need to reschedule or cancel? Simply reply to this message. We look forward to seeing you!`,
      ar: `مرحبًا {{1}}، تم تأكيد حجزك في {{2}} ✅

🔹 الخدمة: {{3}}
📅 التاريخ: {{4}}
⏰ الوقت: {{5}}
👤 مع: {{6}}
🔖 رقم الحجز: {{7}}

لو حابب تغيّر الميعاد أو تلغيه، رد على هذه الرسالة. في انتظارك!`,
    },
    example: ["Fatima", "Glow Salon", "Haircut & Styling", "17/10/2026", "16:00", "Sara", "A1B2C3D4"],
  },
  BOOKING_MERCHANT_ALERT: {
    name: "bf_new_booking_alert",
    params: ["business", "name", "phone", "services", "resource", "date", "time", "reference"],
    body: {
      en: `New booking at {{1}} 🔔

👤 Customer: {{2}} ({{3}})
🔹 Service: {{4}}
🧑‍💼 With: {{5}}
📅 {{6}} at {{7}}
🔖 Ref: {{8}}

Open your dashboard for full details.`,
      ar: `حجز جديد في {{1}} 🔔

👤 العميل: {{2}} ({{3}})
🔹 الخدمة: {{4}}
🧑‍💼 مع: {{5}}
📅 {{6}} الساعة {{7}}
🔖 رقم الحجز: {{8}}

كل التفاصيل في لوحة التحكم.`,
    },
    example: ["Glow Salon", "Fatima", "97455512345", "Haircut & Styling", "Sara", "17/10/2026", "16:00", "A1B2C3D4"],
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
