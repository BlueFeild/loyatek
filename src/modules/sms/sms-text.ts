// أدوات صافية (من غير قاعدة بيانات) لرسايل SMS: عدّ الأجزاء (segments)، تنظيف الأرقام،
// قراءة قايمة الأرقام الملصوقة، وتعبئة {name}

export const SMS_BODY_MAX = 1000;
export const SMS_PASTE_MAX = 5000;

// حروف GSM-7 الأساسية (حرف = 1) والإضافية (حرف = 2 لأنها بتتبعت بعلامة هروب)
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";
const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENDED = new Set(Array.from(GSM_EXTENDED));

export type SmsEncoding = "GSM-7" | "UCS-2";
export interface SegmentInfo {
  encoding: SmsEncoding;
  chars: number; // الطول اللي المزوّد بيحسبه (GSM: الإضافي = 2، UCS-2: وحدات UTF-16 → الإيموجي = 2)
  segments: number;
  remainingInPart: number; // كام حرف فاضل في الجزء الحالي قبل ما الرسالة تبقى جزء زيادة
}

// رسالة واحدة: 160 حرف إنجليزي أو 70 عربي/إيموجي. أكتر من كده بتتقسم:
// 153 / 67 لكل جزء (الباقي بيروح للهيدر اللي بيجمّع الأجزاء عند الموبايل)
export function countSegments(text: string): SegmentInfo {
  let gsm = true;
  let gsmLen = 0;
  for (const ch of Array.from(text)) {
    if (BASIC.has(ch)) gsmLen += 1;
    else if (EXTENDED.has(ch)) gsmLen += 2;
    else {
      gsm = false;
      break;
    }
  }
  const encoding: SmsEncoding = gsm ? "GSM-7" : "UCS-2";
  const chars = gsm ? gsmLen : text.length; // text.length = وحدات UTF-16
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (chars === 0) return { encoding, chars, segments: 0, remainingInPart: single };
  if (chars <= single) return { encoding, chars, segments: 1, remainingInPart: single - chars };
  const segments = Math.ceil(chars / multi);
  return { encoding, chars, segments, remainingInPart: segments * multi - chars };
}

// رقم دولي: أرقام بس مع كود الدولة (974XXXXXXXX). "+" و"00" والمسافات بتتشال.
// أقل من 10 أرقام = غالبًا ناقص كود الدولة → مرفوض (مش هنخمّن الدولة)
export function normalizePhone(raw: string): string | null {
  let d = String(raw ?? "").trim().replace(/[\s\-().]/g, "");
  if (/[^+\d]/.test(d)) return null;
  d = d.replace(/^\+/, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!/^[1-9]\d{9,14}$/.test(d)) return null;
  return d;
}

// للعرض: 9745****1234
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length <= 6) return d;
  return d.slice(0, 4) + "*".repeat(d.length - 8 > 0 ? d.length - 8 : 2) + d.slice(-4);
}

export interface Recipient {
  phone: string;
  name: string;
}
export interface PasteResult {
  recipients: Recipient[];
  invalid: { line: number; text: string }[];
  duplicates: number;
  tooMany: boolean;
}

// كل سطر: "رقم" أو "رقم,اسم" (أو ; أو تاب). سطور فاضية بتتجاهل، الأرقام المكررة بتتشال
export function parsePastedList(text: string, max = SMS_PASTE_MAX): PasteResult {
  const recipients: Recipient[] = [];
  const invalid: { line: number; text: string }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let tooMany = false;
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    const [rawPhone, ...rest] = line.split(/[,;\t]/);
    const phone = normalizePhone(rawPhone ?? "");
    if (!phone) {
      if (invalid.length < 50) invalid.push({ line: i + 1, text: line.slice(0, 60) });
      return;
    }
    if (seen.has(phone)) {
      duplicates++;
      return;
    }
    if (recipients.length >= max) {
      tooMany = true;
      return;
    }
    seen.add(phone);
    recipients.push({ phone, name: rest.join(" ").trim().slice(0, 80) });
  });
  return { recipients, invalid, duplicates, tooMany };
}

// {name} = اسم المستلم (أو فاضي لو مش معروف - من غير ما يسيب مسافة غريبة)
export function renderSmsBody(body: string, name: string): string {
  const n = (name ?? "").trim();
  if (n) return body.replace(/\{name\}/gi, n);
  return body
    .replace(/[ \t]*\{name\}/gi, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/ +([,!.،؟?])/g, "$1");
}

// اسم المرسل: 3-11 حرف/رقم إنجليزي ويبدأ بحرف
export const SENDER_NAME_RE = /^[A-Za-z][A-Za-z0-9]{2,10}$/;
