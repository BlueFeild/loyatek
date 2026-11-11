import { prisma } from "../../config/db";
import { getOrCreateWhatsappSettings, getWhatsappTemplateStatus, findWhatsappTemplateByName, graphBase, recordWhatsappMessage } from "../whatsapp/whatsapp.service";
import type { OtpSender } from "./wa-login.types";

// قالب Meta من نوع AUTHENTICATION (زرار "نسخ الكود"). Meta بتكتب النص نفسه:
// "<الكود> is your verification code. For your security, do not share this code."
export const LOGIN_TEMPLATE_PURPOSE = "LOGIN_CODE";
export function loginTemplateName(lang: "en" | "ar") {
  return `bf_login_code_${lang}`;
}

async function graphJson(res: Response) {
  return (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string }; messages?: { id: string }[] };
}

// إنشاء القالب عند Meta (مرة واحدة لكل لغة) وتسجيله عندنا PENDING
export async function submitLoginTemplate(tenantId: string, lang: "en" | "ar") {
  const settings = await getOrCreateWhatsappSettings(tenantId);
  if (!settings.isConnected || !settings.metaAccessToken || !settings.metaWabaId) {
    throw new Error("Connect WhatsApp (with your WABA ID) and press “Verify connection” first.");
  }
  const name = loginTemplateName(lang);
  const existing = await prisma.whatsappTemplate.findFirst({ where: { tenantId, name } });
  if (existing && existing.status !== "REJECTED") return { name, status: existing.status };

  let metaTemplateId: string | undefined;
  let status: "PENDING" | "APPROVED" | "REJECTED" = "PENDING";
  const res = await fetch(`${graphBase()}/${settings.metaWabaId}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.metaAccessToken}` },
    body: JSON.stringify({
      name,
      language: lang,
      category: "AUTHENTICATION",
      components: [
        { type: "BODY", add_security_recommendation: true },
        { type: "FOOTER", code_expiration_minutes: 5 },
        { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: lang === "ar" ? "نسخ الكود" : "Copy code" }] },
      ],
    }),
  });
  const data = await graphJson(res);
  if (res.ok && data.id) {
    metaTemplateId = data.id;
    if (data.status === "APPROVED") status = "APPROVED";
  } else {
    const found = await findWhatsappTemplateByName(settings.metaAccessToken, settings.metaWabaId, name, lang);
    if (!found) throw new Error(data.error?.message || "Meta refused the login template");
    metaTemplateId = found.id;
    status = found.status === "APPROVED" ? "APPROVED" : found.status === "REJECTED" ? "REJECTED" : "PENDING";
  }
  const row = {
    tenantId,
    settingsId: settings.id,
    name,
    language: lang,
    category: "AUTHENTICATION",
    bodyText: lang === "ar" ? "{{1}} هو كود التحقق الخاص بك." : "{{1}} is your verification code.",
    metaTemplateId,
    status,
    rejectionReason: null,
    purpose: LOGIN_TEMPLATE_PURPOSE,
  };
  if (existing) await prisma.whatsappTemplate.update({ where: { id: existing.id }, data: row });
  else await prisma.whatsappTemplate.create({ data: row });
  return { name, status };
}

// حالة القالب (ولو لسه PENDING بنسأل Meta)
export async function loginTemplateStatus(tenantId: string, lang: "en" | "ar"): Promise<{ name: string; status: "NONE" | "PENDING" | "APPROVED" | "REJECTED"; reason?: string | null }> {
  const name = loginTemplateName(lang);
  const tpl = await prisma.whatsappTemplate.findFirst({ where: { tenantId, name } });
  if (!tpl) return { name, status: "NONE" };
  if (tpl.status === "PENDING" && tpl.metaTemplateId) {
    const settings = await getOrCreateWhatsappSettings(tenantId);
    if (settings.metaAccessToken) {
      const check = await getWhatsappTemplateStatus(settings.metaAccessToken, tpl.metaTemplateId);
      if (check.ok && (check.status === "APPROVED" || check.status === "REJECTED")) {
        const u = await prisma.whatsappTemplate.update({ where: { id: tpl.id }, data: { status: check.status, rejectionReason: check.rejectionReason ?? null } });
        return { name, status: u.status as "APPROVED" | "REJECTED", reason: u.rejectionReason };
      }
    }
  }
  return { name, status: tpl.status as "PENDING" | "APPROVED" | "REJECTED", reason: tpl.rejectionReason };
}

// الإرسال الحقيقي عن طريق Meta (من رقم واتساب التاجر)
export class MetaOtpSender implements OtpSender {
  async send(tenantId: string, phone: string, code: string, lang: "en" | "ar") {
    const settings = await getOrCreateWhatsappSettings(tenantId);
    if (!settings.isConnected || !settings.metaAccessToken || !settings.metaPhoneNumberId) {
      return { ok: false as const, error: "This business hasn't connected WhatsApp yet.", code: "WA_NOT_CONNECTED" };
    }
    const tpl = await loginTemplateStatus(tenantId, lang);
    if (tpl.status !== "APPROVED") {
      return { ok: false as const, error: "WhatsApp login isn't ready yet (the code message is waiting for Meta's approval).", code: "TEMPLATE_NOT_APPROVED" };
    }
    try {
      const res = await fetch(`${graphBase()}/${settings.metaPhoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.metaAccessToken}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: tpl.name,
            language: { code: lang },
            components: [
              { type: "body", parameters: [{ type: "text", text: code }] },
              { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
            ],
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await graphJson(res);
      // في Team Inbox بنسجّل إن كود اتبعت - من غير الكود نفسه
      await recordWhatsappMessage({
        tenantId,
        direction: "OUT",
        contactPhone: phone,
        body: lang === "ar" ? "🔐 كود تحقق (مخفي)" : "🔐 Verification code (hidden)",
        kind: "template",
        waMessageId: data.messages?.[0]?.id,
        status: res.ok ? "sent" : "failed",
        error: res.ok ? null : data.error?.message ?? "Meta refused the message",
      }).catch(() => {});
      if (!res.ok) return { ok: false as const, error: data.error?.message || "WhatsApp couldn't deliver the code. Check the number and try again." };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "WhatsApp is not reachable right now. Please try again." };
    }
  }
}
