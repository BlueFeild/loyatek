import { z } from "zod";
import { graphBase } from "./whatsapp.service";

// قوالب واتساب "الغنية": قالب بصورة فوق (Standard + header) وقالب كاروسيل (كروت تتقلّب،
// كل كارت صورة + كلام قصير + زرار أو اتنين - زي حملات talabat).
// المهم وقت الإرسال: Meta بتطلب الصورة مع كل رسالة. بنرفع كل صورة مرة واحدة
// (/{phone-id}/media) ونبعت الـ media id لكل المستلمين - قبل كده الحملة بالصورة كانت بتفشل

export const MAX_CARDS = 10;
// أي نداء لـ Meta مايعلقش أكتر من كده (الحملات بتستنى عليه)
export const META_FETCH_TIMEOUT_MS = 20_000;
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

interface TemplateLike {
  format?: string | null;
  bodyText: string;
  headerImageDataUrl?: string | null;
  cards?: unknown;
}

export function templateCards(t: TemplateLike): StoredCard[] {
  return t.format === "CAROUSEL" && Array.isArray(t.cards) ? (t.cards as StoredCard[]) : [];
}

// الصور اللي لازم تترفع قبل الإرسال: صورة الرأس، أو صورة كل كارت (بالترتيب)
export function templateImages(t: TemplateLike): string[] {
  if (t.format === "CAROUSEL") return templateCards(t).map((c) => c.imageDataUrl);
  return t.headerImageDataUrl ? [t.headerImageDataUrl] : [];
}

// مكوّنات الرسالة وقت الإرسال (Meta بتطلب الصور هنا + متغيرات النص + payload لكل رد سريع)
export function buildSendComponents(t: TemplateLike, mediaIds: string[], bodyParams: string[]) {
  const components: Record<string, unknown>[] = [];
  const isCarousel = t.format === "CAROUSEL";
  if (!isCarousel && mediaIds[0]) components.push({ type: "header", parameters: [{ type: "image", image: { id: mediaIds[0] } }] });
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: p.trim() || "-" })) });
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
  if (!cards.length) return t.headerImageDataUrl ? `🖼️ ${body}` : body;
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
    form.append("file", new Blob([parsed.buffer], { type: parsed.mime }), parsed.mime === "image/png" ? "image.png" : "image.jpg");
    const res = await fetch(`${graphBase()}/${phoneNumberId}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS) });
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
