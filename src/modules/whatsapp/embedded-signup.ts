import crypto from "crypto";
import { graphBase } from "./whatsapp.service";

// Embedded Signup (الطريقة الرسمية من Meta): التاجر يدوس "Connect WhatsApp" جوه
// المنصة، تفتح نافذة Meta، يسجل دخول ويختار/ينشئ حساب البيزنس (WABA) ورقمه
// ويأكده بكود - ونستلم إحنا WABA ID + Phone number ID + كود بيتبدّل بتوكن.
// محتاج تطبيق Meta واحد للمنصة (Tech Provider) - المتغيرات دي في Railway بس:
//   META_APP_ID, META_APP_SECRET, META_EMBEDDED_SIGNUP_CONFIG_ID,
//   META_WEBHOOK_VERIFY_TOKEN (للـ webhook العام بتاع المنصة)
export function embeddedSignupConfig() {
  const appId = process.env.META_APP_ID?.trim() || "";
  const configId = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim() || "";
  const hasSecret = Boolean(process.env.META_APP_SECRET?.trim());
  return {
    enabled: Boolean(appId && configId && hasSecret),
    // دول عامين (بيتحطوا في الصفحة) - السر نفسه مابيطلعش من السيرفر أبدًا
    appId: appId || null,
    configId: configId || null,
    // نسخة مكتبة فيسبوك (FB.init) - Embedded Signup v4 بيستخدم v26.0 في كود Meta نفسه
    graphVersion: (process.env.META_GRAPH_VERSION || "v26.0").trim(),
  };
}

type GraphJson = { error?: { message?: string } } & Record<string, any>;

async function graph(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await fetch(`${graphBase()}${path}`, {
    ...rest,
    headers: { ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const data = ((await res.json().catch(() => ({}))) ?? {}) as GraphJson;
  return { ok: res.ok && !data.error, data, error: data.error?.message || (res.ok ? null : `Meta error ${res.status}`) };
}

// الكود اللي رجع من نافذة Meta -> توكن البيزنس بتاع التاجر
export async function exchangeSignupCode(code: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const appId = process.env.META_APP_ID?.trim();
  const secret = process.env.META_APP_SECRET?.trim();
  if (!appId || !secret) return { ok: false, error: "Embedded Signup isn't set up on the server yet." };
  const q = new URLSearchParams({ client_id: appId, client_secret: secret, code });
  const r = await graph(`/oauth/access_token?${q.toString()}`);
  if (!r.ok || typeof r.data.access_token !== "string") return { ok: false, error: r.error || "Meta didn't return an access token" };
  return { ok: true, token: r.data.access_token };
}

// نخلّي تطبيق المنصة يستقبل رسايل حساب التاجر (webhook)
export async function subscribeAppToWaba(token: string, wabaId: string) {
  return graph(`/${wabaId}/subscribed_apps`, { method: "POST", token });
}

// تفعيل الرقم على Cloud API (PIN للتحقق بخطوتين). لو الرقم متفعّل قبل كده
// Meta ممكن ترجّع خطأ - مش بنوقف الربط عليه
// pin: لو الرقم عليه تحقق بخطوتين قبل كده لازم نفس الـ PIN، وإلا أي 6 أرقام
export async function registerPhoneNumber(token: string, phoneNumberId: string, pinInput?: string) {
  const pin = pinInput && /^\d{6}$/.test(pinInput) ? pinInput : String(crypto.randomInt(100000, 1000000));
  return graph(`/${phoneNumberId}/register`, { method: "POST", token, body: JSON.stringify({ messaging_product: "whatsapp", pin }) });
}

// في ربط تطبيق الموبايل (Coexistence) Meta ممكن ماتبعتش phone_number_id في رسالة
// الانتهاء - بنسأل Meta عن أرقام حساب البيزنس ونختار الرقم اللي على التطبيق
export async function findWabaPhoneNumber(token: string, wabaId: string): Promise<{ ok: boolean; phoneNumberId?: string; error?: string }> {
  const r = await graph(`/${wabaId}/phone_numbers?fields=id,display_phone_number,is_on_biz_app,platform_type`, { token });
  if (!r.ok) return { ok: false, error: r.error ?? "Couldn't read the phone numbers from Meta" };
  const list: { id: string; is_on_biz_app?: boolean; platform_type?: string }[] = Array.isArray(r.data.data) ? r.data.data : [];
  const pick = list.find((n) => n.is_on_biz_app) ?? (list.length === 1 ? list[0] : undefined);
  return pick ? { ok: true, phoneNumberId: String(pick.id) } : { ok: false, error: list.length ? "This WhatsApp account has more than one number — pick it again in the Meta window." : "No phone number found on this WhatsApp account." };
}
