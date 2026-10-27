import { getWhatsappTemplateStatus, sendWhatsappAudioMessage, sendWhatsappTestMessage, uploadWhatsappAudio } from "./whatsapp.service";
import { sendTemplateComponents, uploadTemplateImages } from "./rich-templates";
import type { MetaConnection } from "./campaign.repository";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface GatewayTemplate {
  format?: string | null;
  bodyText: string;
  headerImageDataUrl?: string | null;
  cards?: unknown;
}

// "عقد" الكلام مع واتساب للحملات: الخدمة مابتعرفش Meta - أي تطبيق (أو Fake للاختبار) بيطبّقه
export interface CampaignGateway {
  templateStatus(conn: MetaConnection, metaTemplateId: string): Promise<{ ok: boolean; status?: string; rejectionReason?: string }>;
  uploadTemplateImages(conn: MetaConnection, tpl: GatewayTemplate): Promise<{ ok: boolean; mediaIds: string[]; error?: string }>;
  uploadAudio(conn: MetaConnection, audioBase64: string): Promise<{ ok: boolean; mediaId?: string; error?: string }>;
  sendTemplate(conn: MetaConnection, to: string, name: string, language: string, components: Record<string, unknown>[]): Promise<SendResult>;
  // من غير قالب خاص: قالب Meta التجريبي hello_world
  sendHelloWorld(conn: MetaConnection, to: string): Promise<SendResult>;
  sendAudio(conn: MetaConnection, to: string, mediaId: string): Promise<SendResult>;
}

// التطبيق الحقيقي: بيلف على الدوال الموجودة (Meta Graph API)
export class MetaCampaignGateway implements CampaignGateway {
  templateStatus(conn: MetaConnection, metaTemplateId: string) {
    return getWhatsappTemplateStatus(conn.token, metaTemplateId);
  }
  uploadTemplateImages(conn: MetaConnection, tpl: GatewayTemplate) {
    return uploadTemplateImages(conn.token, conn.phoneNumberId, tpl);
  }
  uploadAudio(conn: MetaConnection, audioBase64: string) {
    return uploadWhatsappAudio(conn.token, conn.phoneNumberId, audioBase64);
  }
  sendTemplate(conn: MetaConnection, to: string, name: string, language: string, components: Record<string, unknown>[]) {
    return sendTemplateComponents(conn.token, conn.phoneNumberId, to, name, language, components);
  }
  sendHelloWorld(conn: MetaConnection, to: string) {
    return sendWhatsappTestMessage(conn.token, conn.phoneNumberId, to, "hello_world", "en_US");
  }
  sendAudio(conn: MetaConnection, to: string, mediaId: string) {
    return sendWhatsappAudioMessage(conn.token, conn.phoneNumberId, to, mediaId);
  }
}
