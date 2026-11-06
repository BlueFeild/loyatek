import crypto from "crypto";
import dns from "dns/promises";
import net from "net";

// الأحداث اللي التاجر يقدر يستقبلها على الـ webhook بتاعه (Make / Zapier / السيستم بتاعه)
export const WEBHOOK_EVENTS = [
  "booking.created",
  "order.created",
  "whatsapp.message.received",
  "social.message.received",
  "post.published",
  "post.failed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// التوقيع: HMAC-SHA256 على "timestamp.body" بالـ secret (زي Stripe) - التاجر يتأكد إن الطلب مننا
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${signWebhook(secret, timestamp, body)}`;
}

// عناوين جوه الشبكة (السيرفر نفسه، الشبكة الداخلية لـ Railway، metadata) ممنوعة
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

// لينك آمن نبعتله: https بس، ومايشاورش على الشبكة الداخلية.
// ALLOW_PRIVATE_WEBHOOKS=1 للاختبار المحلي بس
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a full link that starts with https://");
  }
  const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOKS === "1";
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) throw new Error("The link must start with https://");
  if (url.username || url.password) throw new Error("Don't put a username or password inside the link");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("This link points to a private address");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new Error("We couldn't find this address — check the link");
  if (addresses.some(isPrivateAddress)) throw new Error("This link points to a private address");
  return url;
}
