import jwt from "jsonwebtoken";
import { JWT as GoogleAuthJWT } from "google-auth-library";

// تكامل Google Wallet - الملف ده نقي: مفيش فيه داتابيز، بس بناء الكائنات
// وتوقيع الـ JWT والنداء على Google REST API، عشان نقدر نختبره لوحده.
// حساب Google واحد على مستوى المنصة (BlueField) هو الـ Issuer، وكل شركة
// ليها Class خاص بيها (اسمها ولوجو وألوانها)، وكل عميل ليه Object واحد

const API_BASE = "https://walletobjects.googleapis.com/walletobjects/v1";
const WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const DEFAULT_COLOR = "#0F172A";

export interface GoogleWalletConfig {
  issuerId: string;
  clientEmail: string;
  privateKey: string;
  origins: string[];
}

// الإعداد بييجي من متغيرات Railway: GOOGLE_WALLET_ISSUER_ID +
// GOOGLE_WALLET_SERVICE_ACCOUNT_JSON (محتوى ملف الـ JSON كامل).
// لو أي واحد ناقص بنرجع null والميزة ببساطة بتتقفل من غير ما نكسر حاجة
export function loadGoogleWalletConfig(env: NodeJS.ProcessEnv = process.env): GoogleWalletConfig | null {
  const issuerId = env.GOOGLE_WALLET_ISSUER_ID?.trim();
  const raw = env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON?.trim();
  if (!issuerId || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null;
    return {
      issuerId,
      clientEmail: parsed.client_email,
      // لو المفتاح اتلصق بـ \n حرفية بدل سطور حقيقية نصلّحها
      privateKey: parsed.private_key.replace(/\\n/g, "\n"),
      origins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

export type GoogleRequester = (
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown
) => Promise<{ status: number; data: any }>;

// الـ requester الحقيقي - بيتوثق بالـ service account. أي رد غير 2xx بيرجع
// كـ {status,data} بدل ما يرمي exception، عشان نتعامل مع 409/404 بهدوء
export function createGoogleRequester(cfg: GoogleWalletConfig): GoogleRequester {
  const client = new GoogleAuthJWT({ email: cfg.clientEmail, key: cfg.privateKey, scopes: [WALLET_SCOPE] });
  return async (method, url, body) => {
    try {
      const res = await client.request({ url, method, data: body });
      return { status: res.status, data: res.data };
    } catch (err: any) {
      const status = err?.response?.status;
      if (typeof status === "number") return { status, data: err.response?.data };
      throw err;
    }
  };
}

function validHex(color: string | null | undefined) {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR;
}

export const classIdFor = (cfg: { issuerId: string }, tenantId: string) => `${cfg.issuerId}.${tenantId}`;
export const objectIdFor = (cfg: { issuerId: string }, customerId: string) => `${cfg.issuerId}.${customerId}`;

export function buildLoyaltyClass(args: {
  issuerId: string;
  tenantId: string;
  tenantName: string;
  themeColor: string | null | undefined;
  logoUrl: string;
}) {
  const name = args.tenantName.slice(0, 60);
  return {
    id: classIdFor(args, args.tenantId),
    issuerName: name,
    programName: name,
    programLogo: {
      sourceUri: { uri: args.logoUrl },
      contentDescription: { defaultValue: { language: "en-US", value: `${name} logo` } },
    },
    hexBackgroundColor: validHex(args.themeColor),
    reviewStatus: "UNDER_REVIEW",
  };
}

export type PassMessage =
  | { kind: "earned"; label: string; rewardId?: string }
  | { kind: "redeemed" };

// الحالة المتغيّرة على الكارت (الأختام + الهدية). دي اللي بتتبعت في كل
// تحديث PATCH؛ مفيش فيها حقول ثابتة زي الباركود عشان مانلمسهاش
export function buildLoyaltyObjectState(args: {
  balance: number;
  stampCount: number;
  rewardText: string;
  availableRewards: number;
  message?: PassMessage;
}) {
  const remaining = Math.max(1, args.stampCount - args.balance);
  const state: Record<string, unknown> = {
    state: "ACTIVE",
    loyaltyPoints: { label: "Stamps", balance: { string: `${args.balance} / ${args.stampCount}` } },
    textModulesData:
      args.availableRewards > 0
        ? [
            {
              id: "gift",
              header: "🎁 Gift ready",
              body: `${args.rewardText}${args.availableRewards > 1 ? ` (x${args.availableRewards})` : ""} — show this card to our staff to redeem it.`,
            },
          ]
        : [
            {
              id: "next",
              header: "Next gift",
              body: `${remaining} more stamp${remaining === 1 ? "" : "s"} to get: ${args.rewardText}`,
            },
          ],
  };

  if (args.message?.kind === "earned") {
    // TEXT_AND_NOTIFY هو اللي بيبعت إشعار فعلي على موبايل العميل
    state.messages = [
      {
        id: `gift-${args.message.rewardId ?? Date.now()}`,
        header: "🎁 You earned a gift!",
        body: args.message.label,
        messageType: "TEXT_AND_NOTIFY",
      },
    ];
  } else if (args.message?.kind === "redeemed") {
    // بنستبدل رسالة الهدية القديمة برسالة عادية (من غير إشعار)
    state.messages = [
      { id: `redeemed-${Date.now()}`, header: "Gift redeemed", body: "Enjoy! Keep collecting stamps.", messageType: "TEXT" },
    ];
  }
  return state;
}

export function buildLoyaltyObject(args: {
  issuerId: string;
  tenantId: string;
  customer: { id: string; name: string; phone: string; memberCode: string; balance: number };
  stampCount: number;
  rewardText: string;
  availableRewards: number;
  message?: PassMessage;
}) {
  return {
    id: objectIdFor(args, args.customer.id),
    classId: classIdFor(args, args.tenantId),
    accountId: args.customer.phone,
    accountName: args.customer.name,
    // الـ QR اللي الموظف بيعمله scan - هو memberCode بالظبط
    barcode: { type: "QR_CODE", value: args.customer.memberCode },
    ...buildLoyaltyObjectState({
      balance: args.customer.balance,
      stampCount: args.stampCount,
      rewardText: args.rewardText,
      availableRewards: args.availableRewards,
      message: args.message,
    }),
  };
}

// رابط "Save to Google Wallet" - JWT صغير (skinny) بيشاور على Object
// موجود فعلًا عند Google، فمفيش مشكلة حجم الرابط
export function buildSaveToWalletUrl(cfg: GoogleWalletConfig, objectId: string) {
  const token = jwt.sign(
    {
      iss: cfg.clientEmail,
      aud: "google",
      typ: "savetowallet",
      origins: cfg.origins,
      payload: { loyaltyObjects: [{ id: objectId }] },
    },
    cfg.privateKey,
    { algorithm: "RS256" }
  );
  return `https://pay.google.com/gp/v/save/${token}`;
}

function failure(action: string, status: number, data: any) {
  const detail = data?.error?.message ?? (typeof data === "string" ? data : JSON.stringify(data ?? {}));
  return new Error(`Google Wallet API ${action} failed (${status}): ${detail}`);
}

// إنشاء الـ Class لو مش موجود، ولو موجود (409) بنحدّثه باللوجو والألوان
export async function ensureLoyaltyClass(req: GoogleRequester, classBody: { id: string }) {
  const created = await req("POST", `${API_BASE}/loyaltyClass`, classBody);
  if (created.status >= 200 && created.status < 300) return;
  if (created.status === 409) {
    const patched = await req("PATCH", `${API_BASE}/loyaltyClass/${encodeURIComponent(classBody.id)}`, classBody);
    if (patched.status >= 200 && patched.status < 300) return;
    throw failure("class update", patched.status, patched.data);
  }
  throw failure("class create", created.status, created.data);
}

export async function upsertLoyaltyObject(req: GoogleRequester, objectBody: { id: string }) {
  const created = await req("POST", `${API_BASE}/loyaltyObject`, objectBody);
  if (created.status >= 200 && created.status < 300) return;
  if (created.status === 409) {
    const { id, ...rest } = objectBody as any;
    const patched = await req("PATCH", `${API_BASE}/loyaltyObject/${encodeURIComponent(id)}`, rest);
    if (patched.status >= 200 && patched.status < 300) return;
    throw failure("object update", patched.status, patched.data);
  }
  throw failure("object create", created.status, created.data);
}

// تحديث كارت موجود. 404 معناها الكارت لسه مش موجود عند Google - مش خطأ
export async function patchLoyaltyObjectState(req: GoogleRequester, objectId: string, state: Record<string, unknown>) {
  const res = await req("PATCH", `${API_BASE}/loyaltyObject/${encodeURIComponent(objectId)}`, state);
  if (res.status >= 200 && res.status < 300) return "updated" as const;
  if (res.status === 404) return "not-found" as const;
  throw failure("object patch", res.status, res.data);
}
