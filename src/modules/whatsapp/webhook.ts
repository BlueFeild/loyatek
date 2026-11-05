import { Router, type Request } from "express";
import crypto from "crypto";
import { prisma } from "../../config/db";
import { recordWhatsappMessage, sendWhatsappTextMessage } from "./whatsapp.service";
import { matchAutoReply, renderBotReply } from "./bot";
import { statusesBelow } from "./campaign-report";
import { OPT_REPLIES } from "./opt-out";
import { container } from "../../core/container";

// Webhook لـ Meta WhatsApp Cloud API - الطريق اللي Meta بتبعتلنا منه الرسايل
// الجاية من العملاء وحالة توصيل رسايلنا. كل تاجر ليه لينك سري خاص بيه
// (/api/public/whatsapp/webhook/<webhookKey>) بيتحط في إعدادات تطبيقه على Meta.
// كل طلب لازم يكون موقّع من Meta بالـ App Secret بتاع التاجر - من غيره
// بنرفضه (عشان محدش يقدر يبعت رسايل وهمية ويخلّي البوت يرد على أرقام عشوائية)
export const publicWhatsappWebhookRouter = Router();

export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

export interface IncomingMessage {
  from: string;
  id: string;
  name?: string;
  text: string;
  type: string;
  // العميل داس على إعلان Click-to-WhatsApp (Meta بتبعت referral مع أول رسالة)
  referral?: AdReferral;
  // id الزرار / الاختيار اللي داس عليه (رسالة interactive أو زرار قالب)
  replyId?: string;
}
export interface AdReferral {
  sourceId: string;
  sourceType: string;
  headline: string;
  body: string;
}
export interface StatusUpdate {
  id: string;
  status: string;
  error?: string;
}

// استخراج الرسايل والحالات من شكل payload بتاع Meta
// رسالة التاجر بعتها بنفسه من تطبيق واتساب Business على الموبايل (Coexistence -
// Meta بتبعتها في smb_message_echoes) - بتتسجل في المحادثة كرسالة صادرة
export interface EchoMessage {
  to: string;
  id: string;
  text: string;
  type: string;
}

type WebhookBatch = { phoneNumberId?: string; messages: IncomingMessage[]; statuses: StatusUpdate[]; echoes: EchoMessage[] };
export function parseWebhookPayload(body: any): WebhookBatch[] {
  const out: WebhookBatch[] = [];
  if (!body || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), c?.profile?.name ?? "");
      const messages: IncomingMessage[] = [];
      for (const m of value.messages ?? []) {
        if (!m?.from || !m?.id) continue;
        const text =
          m.type === "text"
            ? m.text?.body ?? ""
            : m.type === "button"
              ? m.button?.text ?? ""
              : m.type === "interactive"
                ? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ""
                : `[${m.type}]`;
        const replyId = m.type === "interactive" ? m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id : m.type === "button" ? m.button?.payload : undefined;
        const ref = m.referral;
        const referral: AdReferral | undefined =
          ref && (ref.source_id || ref.headline)
            ? { sourceId: String(ref.source_id ?? ""), sourceType: String(ref.source_type ?? "ad"), headline: String(ref.headline ?? "").slice(0, 200), body: String(ref.body ?? "").slice(0, 500) }
            : undefined;
        messages.push({ from: String(m.from), id: String(m.id), name: names.get(String(m.from)) || undefined, text: String(text), type: String(m.type), ...(referral ? { referral } : {}), ...(replyId ? { replyId: String(replyId) } : {}) });
      }
      const echoes: EchoMessage[] = [];
      for (const m of value.message_echoes ?? []) {
        if (!m?.to || !m?.id) continue;
        echoes.push({ to: String(m.to), id: String(m.id), text: String(m.type === "text" ? m.text?.body ?? "" : `[${m.type}]`), type: String(m.type ?? "text") });
      }
      const statuses: StatusUpdate[] = [];
      for (const s of value.statuses ?? []) {
        if (!s?.id || !s?.status) continue;
        statuses.push({ id: String(s.id), status: String(s.status), error: s.errors?.[0]?.title || s.errors?.[0]?.message });
      }
      out.push({ phoneNumberId: value.metadata?.phone_number_id ? String(value.metadata.phone_number_id) : undefined, messages, statuses, echoes });
    }
  }
  return out;
}

// خطوة التحقق اللي Meta بتعملها مرة واحدة وقت ما التاجر يحط اللينك
publicWhatsappWebhookRouter.get("/:key", async (req, res) => {
  const settings = await prisma.whatsappSettings.findUnique({ where: { webhookKey: req.params.key } });
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (!settings || mode !== "subscribe" || !settings.webhookVerifyToken || token !== settings.webhookVerifyToken) {
    return res.status(403).send("Forbidden");
  }
  res.status(200).type("text/plain").send(String(challenge ?? ""));
});

publicWhatsappWebhookRouter.post("/:key", async (req: Request & { rawBody?: Buffer }, res) => {
  const settings = await prisma.whatsappSettings.findUnique({ where: { webhookKey: req.params.key } });
  if (!settings) return res.sendStatus(404);
  if (!settings.metaAppSecret || !verifyMetaSignature(req.rawBody, req.header("x-hub-signature-256"), settings.metaAppSecret)) {
    return res.sendStatus(401);
  }
  // Meta عايزة رد 200 بسرعة - بنعالج بعد الرد
  res.sendStatus(200);
  try {
    await handleWebhook(settings.tenantId, req.body);
  } catch (err) {
    console.warn(`[whatsapp-webhook] processing failed for tenant ${settings.tenantId}: ${(err as Error)?.message}`);
  }
});

// Webhook المنصة نفسها (للتجار اللي ربطوا بـ Embedded Signup): لينك واحد بيتحط
// مرة واحدة في تطبيق Meta بتاع المنصة، موقّع بـ META_APP_SECRET، وكل رسالة
// بتروح للتاجر صاحب الرقم (phone_number_id)
export const platformWhatsappWebhookRouter = Router();

platformWhatsappWebhookRouter.get("/", (req, res) => {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (!expected || req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== expected) return res.status(403).send("Forbidden");
  res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
});

platformWhatsappWebhookRouter.post("/", async (req: Request & { rawBody?: Buffer }, res) => {
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret || !verifyMetaSignature(req.rawBody, req.header("x-hub-signature-256"), secret)) {
    // بيظهر في Railway logs - غالبًا META_APP_SECRET مش هو App Secret بتاع التطبيق ده
    console.warn(`[whatsapp-webhook] platform webhook rejected: ${!secret ? "META_APP_SECRET is not set" : "signature mismatch (check META_APP_SECRET)"}`);
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const phoneIds = Array.from(new Set(parseWebhookPayload(req.body).map((b) => b.phoneNumberId).filter((x): x is string => Boolean(x))));
  for (const phoneNumberId of phoneIds) {
    // الرقم بيبقى تبع حساب واحد عند Meta - لو اتربط بأكتر من شركة عندنا، آخر
    // شركة ربطته (واتأكد من Meta) هي صاحبته
    const owners = await prisma.whatsappSettings.findMany({
      where: { metaPhoneNumberId: phoneNumberId, isConnected: true },
      orderBy: { lastVerifiedAt: "desc" },
      take: 1,
      select: { tenantId: true },
    });
    // نفس الرقم ممكن يكون رقم إضافي (فرع) عند شركة
    const extraOwners = owners.length ? [] : await container.whatsappNumbers.tenantsWithExtra(phoneNumberId);
    const all = [...owners.map((o) => o.tenantId), ...extraOwners].map((tenantId) => ({ tenantId }));
    if (all.length === 0) console.warn(`[whatsapp-webhook] message for phone number id ${phoneNumberId} but no connected company has it`);
    for (const o of all) {
      try {
        // handleWebhook بيتجاهل أي رقم غير رقم التاجر ده
        await handleWebhook(o.tenantId, req.body);
      } catch (err) {
        console.warn(`[whatsapp-webhook] platform processing failed for tenant ${o.tenantId}: ${(err as Error)?.message}`);
      }
    }
  }
});

export async function handleWebhook(tenantId: string, body: any) {
  const settings = await prisma.whatsappSettings.findUnique({ where: { tenantId } });
  if (!settings) return;
  await prisma.whatsappSettings.update({ where: { tenantId }, data: { lastWebhookAt: new Date() } });

  for (const batch of parseWebhookPayload(body)) {
    // رسايل لرقم مش تبع التاجر (لا الأساسي ولا رقم إضافي متوصل) - بنتجاهلها
    if (batch.phoneNumberId && !(await container.whatsappNumbers.ownsIncoming(tenantId, batch.phoneNumberId, settings.metaPhoneNumberId))) continue;
    const viaNumber = batch.phoneNumberId ?? settings.metaPhoneNumberId ?? null;

    for (const s of batch.statuses) {
      // الحالة بتتقدّم بس (sent ← delivered ← read) - Meta ممكن تبعت delivered متأخرة بعد read
      const below = statusesBelow(s.status);
      await prisma.whatsappMessage.updateMany({
        where: { tenantId, waMessageId: s.id, ...(below ? { status: { in: below } } : {}) },
        data: { status: s.status, ...(s.error ? { error: s.error } : {}) },
      });
    }

    for (const m of batch.messages) {
      const already = await prisma.whatsappMessage.findUnique({ where: { waMessageId: m.id } });
      if (already) continue; // Meta بتعيد بعت نفس الرسالة أحيانًا
      await recordWhatsappMessage({ tenantId, direction: "IN", contactPhone: m.from, contactName: m.name, body: m.text, kind: m.type, waMessageId: m.id, phoneNumberId: viaNumber });
      // جه من إعلان ← بنسجّل الإعلان على المحادثة (يظهر في Team Inbox والإحصائيات وفي الإعلان نفسه)
      if (m.referral) await recordAdSource(tenantId, m.from.replace(/[^\d]/g, ""), m.referral);
      // دفتر جهات الاتصال + STOP / START (لو كده: نأكد للعميل ومانشغّلش البوت)
      const intent = await container.contactBookService.handleInbound(tenantId, m.from, m.name ?? null, m.text).catch((err) => {
        console.warn(`[whatsapp-webhook] contact book: ${(err as Error)?.message}`);
        return null;
      });
      if (intent) {
        await confirmOptChange(tenantId, m, intent);
        continue;
      }
      // السيناريوهات (Flow Builder) الأول: كلمة بتبدأ سيناريو، أو العميل في نص سيناريو (داس زرار / بيجاوب سؤال)
      const phone = m.from.replace(/[^\d]/g, "");
      const byFlow = await container.flowService
        .handleInbound(tenantId, { phone, name: m.name ?? null, text: m.text, type: m.type, replyId: m.replyId ?? null })
        .catch((err) => {
          console.warn(`[whatsapp-webhook] flow: ${(err as Error)?.message}`);
          return false;
        });
      if (byFlow) {
        // المحادثة اتسجلت (عشان الموظف الذكي يعرف إن العميل كتب)
        await container.aiAgentService.noteInbound(tenantId, phone).catch(() => {});
        continue;
      }
      // الموظف الذكي الأول (لو مفعّل)؛ لو المحادثة مع موظف بشري محدش يرد؛ غير كده البوت العادي بالكلمات
      const outcome = await container.aiAgentService
        .handleInbound(tenantId, { phone: m.from.replace(/[^\d]/g, ""), name: m.name ?? null, text: m.text, type: m.type, ad: m.referral ? { headline: m.referral.headline, body: m.referral.body } : null })
        .catch((err) => {
          console.warn(`[whatsapp-webhook] ai agent: ${(err as Error)?.message}`);
          return "skipped" as const;
        });
      if (outcome !== "skipped") continue;
      await runBot(tenantId, m);
    }

    // اللي التاجر بعته من الموبايل - بيتسجل بس (البوت مابيردش عليه)
    for (const e of batch.echoes) {
      const already = await prisma.whatsappMessage.findUnique({ where: { waMessageId: e.id } });
      if (already) continue;
      await recordWhatsappMessage({ tenantId, direction: "OUT", contactPhone: e.to, body: e.text, kind: "app", waMessageId: e.id, status: "sent" });
    }
  }
}

async function recordAdSource(tenantId: string, phone: string, ref: AdReferral) {
  const data = { sourceAdId: ref.sourceId || null, sourceAdHeadline: ref.headline || null, sourceAt: new Date() };
  await prisma.whatsappConversation
    .upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, ...data }, update: data })
    .catch((err) => console.warn(`[whatsapp-webhook] ad source: ${(err as Error)?.message}`));
}

async function confirmOptChange(tenantId: string, m: IncomingMessage, intent: "OUT" | "IN") {
  const sender = await container.whatsappNumbers.senderFor(tenantId, { customerPhone: m.from });
  if (!sender) return;
  const body = OPT_REPLIES[intent];
  const result = await sendWhatsappTextMessage(sender.token, sender.phoneNumberId, m.from, body);
  await recordWhatsappMessage({
    phoneNumberId: sender.phoneNumberId,
    tenantId,
    direction: "OUT",
    contactPhone: m.from,
    contactName: m.name,
    body,
    kind: intent === "OUT" ? "opt-out" : "opt-in",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
}

function publicBase() {
  return (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");
}

// البوت: رد تلقائي بالكلمات المفتاحية، أو الرد الافتراضي (مرة كل 12 ساعة
// للرقم الواحد عشان مايبقاش مزعج)
async function runBot(tenantId: string, m: IncomingMessage) {
  const settings = await prisma.whatsappSettings.findUnique({ where: { tenantId } });
  if (!settings?.botEnabled || !settings.isConnected || !settings.metaAccessToken || !settings.metaPhoneNumberId) return;
  // الحساب موقوف: الرسايل بتتسجّل بس البوت مابيردش
  const owner = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { accountStatus: true, isPlatformOwner: true } });
  if (owner && !owner.isPlatformOwner && owner.accountStatus !== "ACTIVE") return;
  if (m.type !== "text" && m.type !== "button" && m.type !== "interactive") return;

  const rules = await prisma.whatsappAutoReply.findMany({ where: { tenantId } });
  const rule = matchAutoReply(m.text, rules);
  let template = rule?.reply ?? "";
  if (!rule) {
    if (!settings.botFallbackReply.trim()) return;
    const recentBot = await prisma.whatsappMessage.findFirst({
      where: { tenantId, contactPhone: m.from, direction: "OUT", kind: "bot-fallback", createdAt: { gt: new Date(Date.now() - 12 * 3600 * 1000) } },
    });
    if (recentBot) return;
    template = settings.botFallbackReply;
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const base = publicBase();
  const reply = renderBotReply(template, {
    name: m.name || "",
    business: tenant?.name ?? "",
    booking_link: tenant?.slug ? `${base}/book/${tenant.slug}` : "",
    menu_link: tenant?.slug ? `${base}/menu/${tenant.slug}` : "",
    links_link: tenant?.slug ? `${base}/l/${tenant.slug}` : "",
  });
  if (!reply) return;

  // الرد من نفس الرقم اللي العميل كتب عليه
  const sender = await container.whatsappNumbers.senderFor(tenantId, { customerPhone: m.from });
  if (!sender) return;
  const result = await sendWhatsappTextMessage(sender.token, sender.phoneNumberId, m.from, reply);
  await recordWhatsappMessage({
    phoneNumberId: sender.phoneNumberId,
    tenantId,
    direction: "OUT",
    contactPhone: m.from,
    contactName: m.name,
    body: reply,
    kind: rule ? "bot" : "bot-fallback",
    waMessageId: result.messageId,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : result.error,
  });
}
