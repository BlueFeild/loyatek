import { prisma } from "../../config/db";

export async function getOrCreateWhatsappSettings(tenantId: string) {
  const existing = await prisma.whatsappSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.whatsappSettings.create({ data: { tenantId } });
}

interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

// شكل رد Meta Graph API الحقيقي - مُعرّف يدويًا لأنه مفيش مكتبة رسمية
// بأنواع TypeScript لـ Meta API، فده بديل حقيقي أدق من any بيغطي بالظبط
// الحقول اللي بنستخدمها فعليًا من الرد
interface MetaGraphResponse {
  id?: string;
  error?: { message?: string };
  messages?: { id: string }[];
}

// بديل آمن لـ catch (err: any) - الـ catch clause نوعها unknown
// افتراضيًا في TypeScript الحديث، فده بيستخرج رسالة الخطأ بأمان بدل
// ما يفترض إن أي حاجة بتوصل هنا فيها .message
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// إرسال رسالة واتساب حقيقية فعليًا عن طريق Meta Graph API - نداء
// حقيقي، مش محاكاة. بتقبل اسم أي قالب معتمد فعليًا (سواء "hello_world"
// الجاهز من Meta، أو قالب مخصّص اتعمل ورفعه التاجر واتوافق عليه) -
// أي قالب تاني غير معتمد هترفضه Meta نفسها برسالة خطأ واضحة
export async function sendWhatsappTestMessage(
  accessToken: string,
  phoneNumberId: string,
  toPhoneNumber: string,
  templateName: string = "hello_world",
  languageCode: string = "en_US"
): Promise<SendMessageResult> {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhoneNumber,
        type: "template",
        template: { name: templateName, language: { code: languageCode } },
      }),
    });

    const data = (await res.json()) as MetaGraphResponse;
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || "Meta rejected the message request" };
    }

    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (err: unknown) {
    return { ok: false, error: `Could not reach Meta: ${errorMessage(err)}` };
  }
}

// رفع الملف الصوتي الحقيقي لسيرفرات Meta - خطوة لازمة قبل إرسال أي
// رسالة صوتية، بترجّع media_id بيتم الإشارة له في كل رسالة إرسال بعد
// كده (رفع واحد بس لكل حملة، مش لكل مستلم)
export async function uploadWhatsappAudio(
  accessToken: string,
  phoneNumberId: string,
  audioBase64: string
): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  try {
    const buffer = Buffer.from(audioBase64, "base64");
    const blob = new Blob([buffer], { type: "audio/webm" });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", blob, "voice-note.webm");

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });

    const data = (await res.json()) as MetaGraphResponse;
    if (!res.ok) return { ok: false, error: data?.error?.message || "Meta rejected the audio upload" };
    return { ok: true, mediaId: data.id };
  } catch (err: unknown) {
    return { ok: false, error: `Could not upload audio to Meta: ${errorMessage(err)}` };
  }
}

// إرسال رسالة صوتية حقيقية بعد ما يترفع الملف - ملحوظة مهمة: واتساب
// مايسمحش برسايل حرة (زي الصوت ده) إلا للأرقام اللي بعتت رسالة لنفس
// الحساب خلال آخر 24 ساعة (نافذة خدمة العملاء) - ده قيد حقيقي من Meta
// نفسها لحماية المستخدمين من السبام، مش قيد من الكود
export async function sendWhatsappAudioMessage(
  accessToken: string,
  phoneNumberId: string,
  toPhoneNumber: string,
  mediaId: string
): Promise<SendMessageResult> {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhoneNumber,
        type: "audio",
        audio: { id: mediaId },
      }),
    });

    const data = (await res.json()) as MetaGraphResponse;
    if (!res.ok) return { ok: false, error: data?.error?.message || "Meta rejected the audio message" };
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (err: unknown) {
    return { ok: false, error: `Could not reach Meta: ${errorMessage(err)}` };
  }
}

interface UnifiedContact {
  name: string;
  phone: string;
  sources: string[];
  lastActivity: Date;
}

// جهات اتصال حقيقية 100% - مجمّعة من العملاء الفعليين في بطاقة الولاء،
// الحجوزات، وطلبات الكتالوج. مفيش رقم واحد وهمي هنا، كله مبني على
// بيانات حقيقية موجودة بالفعل في النظام.
export async function getUnifiedContacts(tenantId: string): Promise<UnifiedContact[]> {
  const [walletCustomers, bookings, orders] = await Promise.all([
    prisma.walletCustomer.findMany({ where: { tenantId } }),
    prisma.booking.findMany({ where: { tenantId } }),
    prisma.catalogOrder.findMany({ where: { tenantId } }),
  ]);

  const byPhone = new Map<string, UnifiedContact>();

  function upsert(name: string, phone: string, source: string, activityDate: Date) {
    if (!phone) return;
    const existing = byPhone.get(phone);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (activityDate > existing.lastActivity) existing.lastActivity = activityDate;
    } else {
      byPhone.set(phone, { name, phone, sources: [source], lastActivity: activityDate });
    }
  }

  for (const c of walletCustomers) {
    upsert(c.name, c.phone, "Wallet Member", c.lastVisitAt ?? c.createdAt);
  }
  for (const b of bookings) {
    upsert(b.customerName, b.customerPhone, "Booking Customer", b.createdAt);
  }
  for (const o of orders) {
    upsert(o.customerName, o.customerPhone, "Catalog Customer", o.createdAt);
  }

  return Array.from(byPhone.values()).sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}

interface CreateTemplateInput {
  name: string;
  language: string;
  category: string;
  bodyText: string;
  buttonText?: string;
  buttonUrl?: string;
  headerImageHandle?: string;
}

interface CreateTemplateResult {
  ok: boolean;
  metaTemplateId?: string;
  error?: string;
}

// إنشاء قالب رسالة حقيقي عند Meta فعليًا (زي قالب دومينوز اللي فيه
// نص وزرار) - Meta بتراجعه وبتاخد من دقايق لأيام، مش بيتفعّل فورًا.
// محتاج WhatsApp Business Account ID (WABA ID)، مختلف عن رقم الهاتف
export async function createWhatsappTemplate(
  accessToken: string,
  wabaId: string,
  input: CreateTemplateInput
): Promise<CreateTemplateResult> {
  try {
    const components: Record<string, unknown>[] = [];
    if (input.headerImageHandle) {
      components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [input.headerImageHandle] } });
    }
    components.push({ type: "BODY", text: input.bodyText });
    if (input.buttonText && input.buttonUrl) {
      components.push({
        type: "BUTTONS",
        buttons: [{ type: "URL", text: input.buttonText, url: input.buttonUrl }],
      });
    }

    const res = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        name: input.name,
        language: input.language,
        category: input.category,
        components,
      }),
    });

    const data = (await res.json()) as MetaGraphResponse;
    if (!res.ok) return { ok: false, error: data?.error?.message || "Meta rejected the template submission" };
    return { ok: true, metaTemplateId: data.id };
  } catch (err: unknown) {
    return { ok: false, error: `Could not reach Meta: ${errorMessage(err)}` };
  }
}

// الاستعلام عن حالة قالب حقيقي عند Meta - PENDING لحد ما فريق
// المراجعة بتاعهم يقرر APPROVED أو REJECTED (بسبب حقيقي بيرجّعوه هم)
export async function getWhatsappTemplateStatus(
  accessToken: string,
  metaTemplateId: string
): Promise<{ ok: boolean; status?: string; rejectionReason?: string; error?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${metaTemplateId}?fields=status,rejected_reason`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as MetaGraphResponse & { status?: string; rejected_reason?: string };
    if (!res.ok) return { ok: false, error: data?.error?.message || "Could not check template status" };
    return { ok: true, status: data.status, rejectionReason: data.rejected_reason };
  } catch (err: unknown) {
    return { ok: false, error: `Could not reach Meta: ${errorMessage(err)}` };
  }
}

// رفع صورة رأس قالب حقيقي لـ Meta عبر Resumable Upload API - نظام
// مختلف تمامًا عن رفع الصوت (uploadWhatsappAudio) وعن الإرسال العادي:
// خطوة 1) نفتح جلسة رفع بنقول لـ Meta حجم ونوع الملف مقدمًا
// خطوة 2) نرفع البايتات الفعلية على نفس الجلسة، وبترجّع لنا "handle"
// الـ handle ده هو اللي بيتحط في القالب نفسه وقت الإنشاء
export async function uploadTemplateHeaderImage(
  accessToken: string,
  appId: string,
  imageBase64: string,
  mimeType: string
): Promise<{ ok: boolean; handle?: string; error?: string }> {
  try {
    const buffer = Buffer.from(imageBase64, "base64");

    // خطوة 1: فتح جلسة رفع
    const sessionRes = await fetch(
      `https://graph.facebook.com/v21.0/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}&access_token=${accessToken}`,
      { method: "POST" }
    );
    const sessionData = (await sessionRes.json()) as { id?: string; error?: { message?: string } };
    if (!sessionRes.ok || !sessionData.id) {
      return { ok: false, error: sessionData?.error?.message || "Failed to start upload session with Meta" };
    }

    // خطوة 2: رفع البايتات الفعلية على نفس الجلسة
    const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${sessionData.id}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0" },
      body: buffer,
    });
    const uploadData = (await uploadRes.json()) as { h?: string; error?: { message?: string } };
    if (!uploadRes.ok || !uploadData.h) {
      return { ok: false, error: uploadData?.error?.message || "Failed to upload the image bytes to Meta" };
    }

    return { ok: true, handle: uploadData.h };
  } catch (err: unknown) {
    return { ok: false, error: `Could not upload image to Meta: ${errorMessage(err)}` };
  }
}
