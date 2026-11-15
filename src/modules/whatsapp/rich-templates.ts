import { z } from "zod";
import { graphBase } from "./whatsapp.service";

// قوالب واتساب "الغنية": قالب بصورة فوق (Standard + header) وقالب كاروسيل (كروت تتقلّب،
// كل كارت صورة + كلام قصير + زرار أو اتنين - زي حملات talabat).
// المهم وقت الإرسال: Meta بتطلب الصورة مع كل رسالة. بنرفع كل صورة مرة واحدة
// (/{phone-id}/media) ونبعت الـ media id لكل المستلمين - قبل كده الحملة بالصورة كانت بتفشل

export const MAX_CARDS = 10;
// أي نداء لـ Meta مايعلقش أكتر من كده (الحملات بتستنى عليه)
export const META_FETCH_TIMEOUT_MS = 20_000;
// رفع فيديو 16MB بياخد وقت أطول من أي نداء عادي
export const MEDIA_UPLOAD_TIMEOUT_MS = 90_000;
export const MIN_CARDS = 2;

const buttonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().trim().min(1).max(25) }),
  z.object({ type: z.literal("URL"), text: z.string().trim().min(1).max(25), url: z.string().trim().url().refine((u) => u.startsWith("https://"), "Button links must start with https://") }),
]);

export const carouselCardSchema = z.object({
  imageBase64: z.string().min(10),
  imageMimeType: z.enum(["image/jpeg", "image/png"]).default("image/jpeg"),
  bodyText: z
    .string()
    .trim()
    .min(1, "Write a short text for every card")
    .max(160, "Card text can be up to 160 characters")
    .refine((t) => !/\{\{\s*\d+\s*\}\}/.test(t), "Card text can't have {{1}} blanks"),
  buttons: z.array(buttonSchema).min(1, "Every card needs at least one button").max(2, "A card can have up to 2 buttons"),
});
export type CarouselCardInput = z.infer<typeof carouselCardSchema>;

// Meta بتشترط إن كل الكروت فيها نفس أنواع الأزرار بنفس الترتيب
export function carouselCardsProblem(cards: CarouselCardInput[]): string | null {
  if (cards.length < MIN_CARDS) return `A carousel needs at least ${MIN_CARDS} cards`;
  if (cards.length > MAX_CARDS) return `A carousel can have up to ${MAX_CARDS} cards`;
  const shape = (c: CarouselCardInput) => c.buttons.map((b) => b.type).join(",");
  const first = shape(cards[0]);
  if (cards.some((c) => shape(c) !== first)) return "All cards must have the same buttons (same types, same order) — WhatsApp requires it";
  return null;
}

export function templateVarCount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export interface StoredCard {
  imageDataUrl: string;
  bodyText: string;
  buttons: { type: "QUICK_REPLY" | "URL"; text: string; url?: string }[];
}

// شكل القالب عند Meta (وقت الإنشاء) - handles = نتيجة رفع صورة كل كارت
export function buildCarouselCreateComponents(bodyText: string, bodyExamples: string[] | undefined, cards: StoredCard[], handles: string[]) {
  const vars = templateVarCount(bodyText);
  return [
    vars > 0 ? { type: "BODY", text: bodyText, example: { body_text: [Array.from({ length: vars }, (_, i) => bodyExamples?.[i] || `Example ${i + 1}`)] } } : { type: "BODY", text: bodyText },
    {
      type: "CAROUSEL",
      cards: cards.map((c, i) => ({
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: [handles[i]] } },
          { type: "BODY", text: c.bodyText },
          {
            type: "BUTTONS",
            buttons: c.buttons.map((b) => (b.type === "URL" ? { type: "URL", text: b.text, url: b.url } : { type: "QUICK_REPLY", text: b.text })),
          },
        ],
      })),
    },
  ];
}

// ---- القالب العادي "الغني" (زي حملات المحلات): صورة/فيديو/PDF فوق + نص + سطر صغير تحت + لحد 3 أزرار ----

export type HeaderType = "IMAGE" | "VIDEO" | "DOCUMENT";
// حدود Meta للرأس (الصورة 5MB، الفيديو 16MB، الملف أكبر بس بنوقف عند 16MB عشان الرسالة تفضل خفيفة)
export const HEADER_MAX_BYTES: Record<HeaderType, number> = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024, DOCUMENT: 16 * 1024 * 1024 };
export const MAX_STANDARD_BUTTONS = 3;
export const FOOTER_MAX = 60;

export function headerTypeForMime(mime: string): HeaderType | null {
  if (mime === "image/jpeg" || mime === "image/png") return "IMAGE";
  if (mime === "video/mp4") return "VIDEO";
  if (mime === "application/pdf") return "DOCUMENT";
  return null;
}

export const standardButtonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("QUICK_REPLY"), text: z.string().trim().min(1, "Write the button text").max(25, "Button text can be up to 25 characters") }),
  z.object({
    type: z.literal("URL"),
    text: z.string().trim().min(1, "Write the button text").max(25, "Button text can be up to 25 characters"),
    url: z.string().trim().url("Enter a full link, e.g. https://your-site.com").refine((u) => u.startsWith("https://"), "Button links must start with https://"),
  }),
  z.object({
    type: z.literal("PHONE_NUMBER"),
    text: z.string().trim().min(1, "Write the button text").max(25, "Button text can be up to 25 characters"),
    phone: z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, "Enter the phone number with country code, e.g. +97455551234"),
  }),
]);
export type StandardButton = z.infer<typeof standardButtonSchema>;

// واتساب بيشترط: لحد 2 لينك، رقم تليفون واحد، والردود السريعة مع بعض (مش متلخبطة وسط اللينكات).
// بنرتبهم لوحدنا: أزرار اللينك/الاتصال الأول، بعدين الردود السريعة - بنفس ترتيبهم جوه كل مجموعة
export function normalizeStandardButtons(buttons: StandardButton[]): { buttons: StandardButton[]; problem: string | null } {
  if (buttons.length > MAX_STANDARD_BUTTONS) return { buttons, problem: `A message can have up to ${MAX_STANDARD_BUTTONS} buttons` };
  if (buttons.filter((b) => b.type === "URL").length > 2) return { buttons, problem: "A message can have up to 2 link buttons" };
  if (buttons.filter((b) => b.type === "PHONE_NUMBER").length > 1) return { buttons, problem: "A message can have only 1 call button" };
  const texts = buttons.map((b) => b.text.trim().toLowerCase());
  if (new Set(texts).size !== texts.length) return { buttons, problem: "Two buttons can't have the same text" };
  const fixed = buttons.map((b) => (b.type === "PHONE_NUMBER" ? { ...b, phone: "+" + b.phone.replace(/[^\d]/g, "") } : b));
  return { buttons: [...fixed.filter((b) => b.type !== "QUICK_REPLY"), ...fixed.filter((b) => b.type === "QUICK_REPLY")], problem: null };
}

// شكل القالب العادي عند Meta وقت الإنشاء (headerHandle = نتيجة رفع ملف الرأس)
export function buildStandardCreateComponents(input: {
  headerType?: HeaderType | null;
  headerHandle?: string;
  bodyText: string;
  bodyExamples?: string[];
  footerText?: string | null;
  buttons?: StandardButton[];
}) {
  const components: Record<string, unknown>[] = [];
  if (input.headerType && input.headerHandle) components.push({ type: "HEADER", format: input.headerType, example: { header_handle: [input.headerHandle] } });
  const vars = templateVarCount(input.bodyText);
  components.push(
    vars > 0
      ? { type: "BODY", text: input.bodyText, example: { body_text: [Array.from({ length: vars }, (_, i) => input.bodyExamples?.[i] || `Example ${i + 1}`)] } }
      : { type: "BODY", text: input.bodyText }
  );
  if (input.footerText?.trim()) components.push({ type: "FOOTER", text: input.footerText.trim() });
  if (input.buttons?.length) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map((b) =>
        b.type === "URL" ? { type: "URL", text: b.text, url: b.url } : b.type === "PHONE_NUMBER" ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone } : { type: "QUICK_REPLY", text: b.text }
      ),
    });
  }
  return components;
}

interface TemplateLike {
  format?: string | null;
  bodyText: string;
  headerImageDataUrl?: string | null;
  headerType?: string | null;
  headerMediaDataUrl?: string | null;
  headerFileName?: string | null;
  footerText?: string | null;
  buttons?: unknown;
  buttonText?: string | null;
  buttonUrl?: string | null;
  cards?: unknown;
}

export function templateCards(t: TemplateLike): StoredCard[] {
  return t.format === "CAROUSEL" && Array.isArray(t.cards) ? (t.cards as StoredCard[]) : [];
}

// رأس القالب العادي: فيديو/ملف (العمود التقيل) أو صورة (العمود القديم)
export function templateHeader(t: TemplateLike): { type: HeaderType; dataUrl: string; fileName: string | null } | null {
  if (t.format === "CAROUSEL") return null;
  if ((t.headerType === "VIDEO" || t.headerType === "DOCUMENT") && t.headerMediaDataUrl) return { type: t.headerType, dataUrl: t.headerMediaDataUrl, fileName: t.headerFileName ?? null };
  if (t.headerImageDataUrl) return { type: "IMAGE", dataUrl: t.headerImageDataUrl, fileName: null };
  return null;
}

// أزرار القالب العادي (الجديدة، أو الزرار القديم الواحد)
export function templateButtons(t: TemplateLike): StandardButton[] {
  if (t.format === "CAROUSEL") return [];
  if (Array.isArray(t.buttons)) return t.buttons as StandardButton[];
  return t.buttonText && t.buttonUrl ? [{ type: "URL", text: t.buttonText, url: t.buttonUrl }] : [];
}

// القالب محتاج يتبعت بمكوّنات (ملف رأس أو كروت)؟ غير كده يتبعت بالطريقة البسيطة
export function needsRichSend(t: TemplateLike): boolean {
  return t.format === "CAROUSEL" || templateHeader(t) !== null;
}

// الملفات اللي لازم تترفع قبل الإرسال: ملف الرأس، أو صورة كل كارت (بالترتيب)
export function templateImages(t: TemplateLike): string[] {
  if (t.format === "CAROUSEL") return templateCards(t).map((c) => c.imageDataUrl);
  const h = templateHeader(t);
  return h ? [h.dataUrl] : [];
}

// مكوّنات الرسالة وقت الإرسال (Meta بتطلب الصور هنا + متغيرات النص + payload لكل رد سريع)
export function buildSendComponents(t: TemplateLike, mediaIds: string[], bodyParams: string[]) {
  const components: Record<string, unknown>[] = [];
  const isCarousel = t.format === "CAROUSEL";
  const header = templateHeader(t);
  if (!isCarousel && header && mediaIds[0]) {
    const media =
      header.type === "VIDEO"
        ? { type: "video", video: { id: mediaIds[0] } }
        : header.type === "DOCUMENT"
          ? { type: "document", document: { id: mediaIds[0], filename: header.fileName || "file.pdf" } }
          : { type: "image", image: { id: mediaIds[0] } };
    components.push({ type: "header", parameters: [media] });
  }
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: p.trim() || "-" })) });
  if (!isCarousel) {
    // payload ثابت لكل رد سريع (btn1, btn2...) عشان نعرف العميل داس على إيه
    templateButtons(t).forEach((b, i) => {
      if (b.type === "QUICK_REPLY") components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: `btn${i + 1}` }] });
    });
  }
  if (isCarousel) {
    components.push({
      type: "carousel",
      cards: templateCards(t).map((c, i) => ({
        card_index: i,
        components: [
          { type: "header", parameters: [{ type: "image", image: { id: mediaIds[i] } }] },
          ...c.buttons
            .map((b, bi) => ({ b, bi }))
            .filter(({ b }) => b.type === "QUICK_REPLY")
            .map(({ bi }) => ({ type: "button", sub_type: "quick_reply", index: String(bi), parameters: [{ type: "payload", payload: `card${i + 1}_btn${bi + 1}` }] })),
        ],
      })),
    });
  }
  return components;
}

// النص اللي بيتسجّل في المحادثة (عشان التاجر يشوف اللي اتبعت)
export function renderTemplatePreview(t: TemplateLike, bodyParams: string[]): string {
  const body = t.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => bodyParams[Number(n) - 1]?.trim() || "-");
  const cards = templateCards(t);
  if (!cards.length) {
    const h = templateHeader(t);
    const icon = h ? (h.type === "VIDEO" ? "🎬 " : h.type === "DOCUMENT" ? "📄 " : "🖼️ ") : "";
    const btns = templateButtons(t);
    return `${icon}${body}${t.footerText ? `\n${t.footerText}` : ""}${btns.length ? `\n[${btns.map((b) => b.text).join(" | ")}]` : ""}`;
  }
  return `${body}\n${cards.map((c, i) => `🃏 ${i + 1}. ${c.bodyText}${c.buttons.length ? ` [${c.buttons.map((b) => b.text).join(" | ")}]` : ""}`).join("\n")}`;
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  return m ? { mime: m[1], buffer: Buffer.from(m[2], "base64") } : null;
}

// رفع صورة كـ media على رقم الواتساب (بتفضل صالحة كذا أسبوع) - الـ id بيتبعت مع كل رسالة
export async function uploadImageMedia(token: string, phoneNumberId: string, dataUrl: string): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: "The template image is missing — create the template again" };
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", parsed.mime);
    const fileName = { "image/png": "image.png", "video/mp4": "video.mp4", "application/pdf": "file.pdf" }[parsed.mime] ?? "image.jpg";
    form.append("file", new Blob([parsed.buffer], { type: parsed.mime }), fileName);
    const res = await fetch(`${graphBase()}/${phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS) });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !data.id) return { ok: false, error: data?.error?.message || "Meta rejected the image upload" };
    return { ok: true, mediaId: String(data.id) };
  } catch (err) {
    return { ok: false, error: `Could not upload the image to Meta: ${(err as Error).message}` };
  }
}

// كل الصور بتترفع مع بعض (كاروسيل لحد 10 كروت) - الترتيب محفوظ
export async function uploadTemplateImages(token: string, phoneNumberId: string, t: TemplateLike): Promise<{ ok: boolean; mediaIds: string[]; error?: string }> {
  const uploads = await Promise.all(templateImages(t).map((img) => uploadImageMedia(token, phoneNumberId, img)));
  const failed = uploads.find((u) => !u.ok || !u.mediaId);
  if (failed) return { ok: false, mediaIds: [], error: failed.error };
  return { ok: true, mediaIds: uploads.map((u) => u.mediaId!) };
}

export async function sendTemplateComponents(token: string, phoneNumberId: string, to: string, name: string, language: string, components: Record<string, unknown>[]) {
  try {
    const template: Record<string, unknown> = { name, language: { code: language } };
    if (components.length) template.components = components;
    const res = await fetch(`${graphBase()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/[^\d]/g, ""), type: "template", template }),
      signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string } };
    if (!res.ok) return { ok: false as const, error: data?.error?.message || "Meta rejected the template message" };
    return { ok: true as const, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { ok: false as const, error: `Could not reach Meta: ${(err as Error).message}` };
  }
}
