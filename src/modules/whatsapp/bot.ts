// البوت: ردود تلقائية بالكلمات المفتاحية. العميل يبعت "حجز" أو "Book"
// فالبوت يرد بلينك الحجز، وهكذا. الرد بيتبعت كنص حر - وده مسموح لأن
// العميل لسه باعت رسالة (نافذة الـ24 ساعة مفتوحة)

// توحيد النص للمقارنة: حروف صغيرة، من غير تشكيل، أ/إ/آ = ا، ة = ه، ى = ي
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ]/g, "") // تشكيل + تطويل
    .replace(/[̀-ͯ]/g, "") // علامات لاتينية
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// الكلمة المفتاحية لازم تكون كلمة (أو جملة) كاملة جوه الرسالة - "book" تطابق
// "I want to book" بس مش "facebook"
export function keywordMatches(message: string, keyword: string): boolean {
  const msg = ` ${normalizeForMatch(message)} `;
  const kw = normalizeForMatch(keyword);
  if (!kw) return false;
  return msg.includes(` ${kw} `);
}

export interface AutoReplyRule {
  id: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  sortOrder: number;
}

// أول قاعدة (بالترتيب) فيها كلمة موجودة في الرسالة
export function matchAutoReply<T extends AutoReplyRule>(message: string, rules: T[]): T | null {
  const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const rule of sorted) {
    if (rule.keywords.some((k) => keywordMatches(message, k))) return rule;
  }
  return null;
}

// {name} {booking_link} {menu_link} {links_link} {business}
export function renderBotReply(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key] : m)).trim();
}
