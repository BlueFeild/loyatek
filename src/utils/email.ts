// إرسال إيميل حقيقي عن طريق Resend (https://resend.com - مجاني لحد 3000
// إيميل في الشهر). المفتاح بيتحط في Railway Variables بس، مش في الكود:
//   RESEND_API_KEY = re_...
//   EMAIL_FROM     = "BlueField <notifications@your-verified-domain.com>"
// من غيرهم الإيميل بيتسكب بهدوء (best effort) ومفيش حاجة بتقع.

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value: string | null | undefined): value is string {
  return Boolean(value && EMAIL_RE.test(value.trim()));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// النص بيتبعت زي ما هو (text) + نسخة HTML بسيطة بنفس الكلام (من غير أي
// HTML من المستخدم - كله escaped)
export async function sendEmail(to: string, subject: string, text: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!isEmailConfigured()) return { ok: false, skipped: true };
  if (!isValidEmail(to)) return { ok: false, error: "invalid recipient" };
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to.trim()], subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[email] Resend rejected the email (${res.status}): ${body.slice(0, 300)}`);
      return { ok: false, error: `Resend ${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn(`[email] could not reach Resend: ${err?.message}`);
    return { ok: false, error: err?.message };
  }
}
