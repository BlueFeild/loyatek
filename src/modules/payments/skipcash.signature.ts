import crypto from "crypto";

// توقيع SkipCash (منطق نقي - متغطي باختبارات). المرجع:
//  https://dev.skipcash.app/doc/authentication/  و  https://dev.skipcash.app/doc/web-hooks/
// - إنشاء دفعة: "Key=Value" مفصولة بفاصلة (من غير مسافات) بالترتيب ده بالظبط، والحقول الفاضية بتتشال
//   من النص ومن الـ body مع بعض. HMAC-SHA256 بالـ Secret Key -> Base64 -> هيدر Authorization (من غير Bearer).
// - الـ webhook: نفس الفكرة بالـ Webhook Key وبالترتيب PaymentId, Amount, StatusId, TransactionId, Custom1, VisaId
//   (TransactionId و Custom1 بس لو موجودين).

export const PAYMENT_SIGNED_FIELDS = [
  "Uid",
  "KeyId",
  "Amount",
  "FirstName",
  "LastName",
  "Phone",
  "Email",
  "Street",
  "City",
  "State",
  "Country",
  "PostalCode",
  "TransactionId",
  "Custom1",
] as const;

export type SkipCashPaymentFields = Partial<Record<(typeof PAYMENT_SIGNED_FIELDS)[number], string>>;

const filled = (v: unknown): v is string | number => v !== undefined && v !== null && String(v) !== "";

export function paymentSignatureString(fields: SkipCashPaymentFields): string {
  return PAYMENT_SIGNED_FIELDS.filter((k) => filled(fields[k]))
    .map((k) => `${k}=${fields[k]}`)
    .join(",");
}

export function hmacBase64(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64");
}

export function signPayment(fields: SkipCashPaymentFields, secretKey: string): string {
  return hmacBase64(paymentSignatureString(fields), secretKey);
}

export interface SkipCashWebhookPayload {
  PaymentId?: unknown;
  Amount?: unknown;
  StatusId?: unknown;
  TransactionId?: unknown;
  Custom1?: unknown;
  VisaId?: unknown;
  [k: string]: unknown;
}

// PaymentId, Amount, StatusId, VisaId دايمًا؛ TransactionId و Custom1 بس لو ليهم قيمة
export function webhookSignatureString(p: SkipCashWebhookPayload, amountText?: string): string {
  const pairs: string[] = [`PaymentId=${p.PaymentId ?? ""}`, `Amount=${amountText ?? p.Amount ?? ""}`, `StatusId=${p.StatusId ?? ""}`];
  if (filled(p.TransactionId)) pairs.push(`TransactionId=${p.TransactionId}`);
  if (filled(p.Custom1)) pairs.push(`Custom1=${p.Custom1}`);
  pairs.push(`VisaId=${p.VisaId ?? ""}`);
  return pairs.join(",");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// المبلغ ممكن ييجي رقم (1.5) أو نص ("1.50") - بنجرّب النص الخام زي ما SkipCash بعتته بالظبط
// (من rawBody) + الشكل بخانتين، عشان التوقيع يطابق مهما كان شكل الـ JSON
export function amountCandidates(p: SkipCashWebhookPayload, rawBody?: Buffer | string): string[] {
  const out = new Set<string>();
  if (filled(p.Amount)) out.add(String(p.Amount));
  if (rawBody) {
    const m = /"Amount"\s*:\s*(?:"([^"]*)"|(-?[0-9.]+))/.exec(rawBody.toString());
    if (m) out.add(m[1] ?? m[2]);
  }
  const n = Number(p.Amount);
  if (filled(p.Amount) && Number.isFinite(n)) out.add(n.toFixed(2));
  return [...out];
}

export function verifyWebhookSignature(p: SkipCashWebhookPayload, header: string | undefined, webhookKey: string, rawBody?: Buffer | string): boolean {
  if (!header || !webhookKey) return false;
  const given = header.trim();
  const amounts = amountCandidates(p, rawBody);
  return (amounts.length ? amounts : [""]).some((a) => safeEqual(hmacBase64(webhookSignatureString(p, a), webhookKey), given));
}

// SkipCash: المبلغ نص بنقطة وخانتين بالكتير
export function skipcashAmount(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2);
}

// TransactionId: لحد 40 حرف ومن غير '#' أو رموز - بنشيل أي حاجة مش حرف/رقم
export function skipcashTransactionId(reference: string): string {
  return reference.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
}

// الاسم: لحد 60 حرف ومن غير رموز (بنسيب الحروف بأي لغة والمسافات)
export function skipcashName(name: string | null | undefined, fallback: string): string {
  const clean = String(name ?? "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return clean || fallback;
}

export function splitName(full: string | null | undefined): { first: string; last: string } {
  const clean = skipcashName(full, "Customer");
  const parts = clean.split(" ");
  const first = parts[0];
  const last = parts.slice(1).join(" ") || first;
  return { first: first.slice(0, 60), last: last.slice(0, 60) };
}

// التليفون: "+" + أرقام (أرقام غير قطرية لازم بكود الدولة بـ +، مش 00) - لحد 15 حرف
export function skipcashPhone(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 14) return null;
  // رقم قطري من 8 أرقام من غير كود: SkipCash بيقبله كده
  if (digits.length === 8 && !raw.startsWith("+")) return digits;
  return `+${digits}`;
}

// إيميل العميل لو مش متسجّل: SkipCash بتقترح {phone}@{domain}
export function skipcashEmail(email: string | null | undefined, phone: string | null): string {
  const e = String(email ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255) return e;
  return `${(phone ?? "").replace(/\D/g, "") || "customer"}@blue-field.co`;
}
