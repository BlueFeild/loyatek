import { prisma } from "../../config/db";
import { recordWhatsappMessage, sendWhatsappTemplate } from "./whatsapp.service";
import { buildSendComponents, needsRichSend, renderTemplatePreview, sendTemplateComponents, templateVarCount, uploadTemplateImages } from "./rich-templates";
import type { WhatsappNumbersService } from "./whatsapp-numbers.service";
import type { SequenceSender } from "./sequence.service";

// إرسال رسالة السلسلة لـ Meta فعليًا: نفس طريقة إرسال القوالب من المحادثات (صورة/فيديو/PDF بيترفعوا، {{1}} = الاسم)
// والرسالة بتتسجل في المحادثة (kind "sequence")
export class MetaSequenceSender implements SequenceSender {
  constructor(private readonly numbers: WhatsappNumbersService) {}

  async send(tenantId: string, phone: string, name: string, templateId: string) {
    const tpl = await prisma.whatsappTemplate.findFirst({ where: { id: templateId, tenantId } });
    if (!tpl) return { ok: false, error: "The template was deleted" };
    if (tpl.status !== "APPROVED") return { ok: false, error: `The template "${tpl.name}" isn't approved by Meta (status: ${tpl.status})` };
    const sender = await this.numbers.senderFor(tenantId, { customerPhone: phone });
    if (!sender) return { ok: false, error: "WhatsApp isn't connected" };

    const params = templateVarCount(tpl.bodyText) > 0 ? [name.trim() || "-"] : [];
    let result: { ok: boolean; messageId?: string; error?: string };
    if (needsRichSend(tpl)) {
      const up = await uploadTemplateImages(sender.token, sender.phoneNumberId, tpl);
      if (!up.ok) return { ok: false, error: up.error };
      result = await sendTemplateComponents(sender.token, sender.phoneNumberId, phone, tpl.name, tpl.language, buildSendComponents(tpl, up.mediaIds, params));
    } else {
      result = await sendWhatsappTemplate(sender.token, sender.phoneNumberId, phone, tpl.name, tpl.language, params);
    }
    await recordWhatsappMessage({
      tenantId,
      direction: "OUT",
      contactPhone: phone,
      contactName: name || null,
      body: renderTemplatePreview(tpl, params),
      kind: "sequence",
      waMessageId: result.ok ? result.messageId ?? null : null,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : result.error ?? null,
      phoneNumberId: sender.phoneNumberId,
    }).catch(() => {});
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
}
