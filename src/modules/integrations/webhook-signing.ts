import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import http from "http";
import https from "https";

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
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 ||
      // نطاقات محجوزة كانت ناقصة (تدقيق SEC-004): 198.18/15 (benchmark)، 192.0.0/24، وعناوين التوثيق
      (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
  }
  if (!net.isIPv6(ip)) return true;
  const v = ip.toLowerCase();
  // IPv6 فيه IPv4 جواه: ::ffff:a.b.c.d / ::a.b.c.d / 64:ff9b::a.b.c.d (NAT64) → نفحص الـ IPv4
  const embedded = v.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isPrivateAddress(embedded[1]);
  const words = expandIPv6(v);
  if (!words) return true;
  if (words.slice(0, 6).every((w) => w === 0) && !(words[6] === 0 && words[7] > 1)) return true; // :: و ::1 و ::x.x
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return isPrivateAddress(wordsToIPv4(words));
  if (words[0] === 0x64 && words[1] === 0xff9b) return isPrivateAddress(wordsToIPv4(words));
  if (words[0] === 0x2002) return isPrivateAddress(`${words[1] >> 8}.${words[1] & 255}.${words[2] >> 8}.${words[2] & 255}`); // 6to4
  const first = words[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

function wordsToIPv4(w: number[]): string {
  return `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
}

function expandIPv6(v: string): number[] | null {
  let s = v.split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8) return null;
  const n = all.map((x) => parseInt(x || "0", 16));
  return n.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff) ? null : n;
}

// lookup آمن للاتصال نفسه: بيتأكد إن العنوان اللي هيتوصل بيه فعلًا مش داخلي.
// قبل كده كنا بنفحص الاسم بـ dns.lookup وبعدين fetch بيعمل lookup تاني (DNS rebinding)
export function safeLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  dns
    .lookup(hostname, { all: true, family: options?.family || 0 })
    .then((list) => {
      if (!list.length) return callback(Object.assign(new Error("We couldn't find this address — check the link"), { code: "ENOTFOUND" }));
      if (process.env.ALLOW_PRIVATE_WEBHOOKS !== "1" && list.some((a) => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error("This link points to a private address"), { code: "EPRIVATE" }));
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    })
    .catch((err) => callback(err));
}

export interface PinnedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: AsyncIterable<Buffer>;
}

// طلب لعنوان خارجي من غير ما يتحوّل لعنوان داخلي: الاتصال بيستخدم safeLookup، ومفيش متابعة redirects
export function pinnedRequest(raw: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<PinnedResponse> {
  const url = typeof raw === "string" ? new URL(raw) : raw;
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: init.method ?? "GET", headers: init.headers, lookup: safeLookup as any, timeout: init.timeoutMs },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res })
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("The link didn't answer in time"), { name: "TimeoutError" })));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
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
