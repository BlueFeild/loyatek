import { PrismaClient } from "@prisma/client";
import { decryptToken, encryptToken } from "../modules/social/token-crypto";

// نسخة واحدة من الاتصال بقاعدة البيانات تُستخدم في كل المشروع
export const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// تدقيق MSG-08: توكن واتساب (Meta) والـ App Secret كانوا متخزنين نص عادي في whatsapp_settings.
// دلوقتي بيتشفّروا (AES-256-GCM، نفس مفتاح توكنات السوشيال) وقت الكتابة، وبيتفكّوا وقت القراءة -
// فباقي الكود بيشوف النص العادي زي ما هو. القيم القديمة (نص عادي) بتتقري زي ما هي، وبتتشفّر أول ما تتحفظ تاني.
const SECRET_FIELDS = ["metaAccessToken", "metaAppSecret"] as const;
const ENCRYPTED = /^v1:[^:]+:[^:]+:[^:]+$/;

export function sealSecret(value: unknown): unknown {
  if (typeof value !== "string" || value === "" || ENCRYPTED.test(value)) return value;
  try {
    return encryptToken(value);
  } catch {
    return value; // مفيش مفتاح (تطوير محلي) - بيتحفظ زي ما هو
  }
}

export function openSecret(value: unknown): unknown {
  if (typeof value !== "string" || !ENCRYPTED.test(value)) return value;
  try {
    return decryptToken(value);
  } catch {
    console.warn("[db] a stored WhatsApp secret could not be decrypted (key changed?) — the merchant must reconnect");
    return null;
  }
}

function sealData(data: unknown) {
  if (!data || typeof data !== "object") return;
  const row = data as Record<string, unknown>;
  for (const f of SECRET_FIELDS) {
    if (f in row) {
      const v = row[f];
      // { set: "..." } شكل Prisma التاني
      if (v && typeof v === "object" && "set" in (v as object)) (v as { set: unknown }).set = sealSecret((v as { set: unknown }).set);
      else row[f] = sealSecret(v);
    }
  }
}

function openRow(row: unknown) {
  if (!row || typeof row !== "object") return;
  const r = row as Record<string, unknown>;
  for (const f of SECRET_FIELDS) if (f in r) r[f] = openSecret(r[f]);
}

prisma.$use(async (params, next) => {
  if (params.model !== "WhatsappSettings") return next(params);
  const args = (params.args ?? {}) as Record<string, unknown>;
  if (Array.isArray(args.data)) args.data.forEach(sealData);
  else sealData(args.data);
  sealData(args.create);
  sealData(args.update);
  const result = await next(params);
  if (Array.isArray(result)) result.forEach(openRow);
  else openRow(result);
  return result;
});

// مرة واحدة وقت تشغيل السيرفر: القيم القديمة اللي لسه نص عادي بتتشفّر (الـ middleware فوق بيشفّر وقت الحفظ)
export async function sealLegacyWhatsappSecrets(): Promise<number> {
  const rows = await prisma.$queryRaw<{ tenantId: string }[]>`
    SELECT "tenantId" FROM whatsapp_settings
    WHERE ("metaAccessToken" IS NOT NULL AND "metaAccessToken" <> '' AND "metaAccessToken" NOT LIKE 'v1:%')
       OR ("metaAppSecret" IS NOT NULL AND "metaAppSecret" <> '' AND "metaAppSecret" NOT LIKE 'v1:%')`;
  let done = 0;
  for (const r of rows) {
    const s = await prisma.whatsappSettings.findUnique({ where: { tenantId: r.tenantId }, select: { metaAccessToken: true, metaAppSecret: true } });
    if (!s) continue;
    await prisma.whatsappSettings.update({ where: { tenantId: r.tenantId }, data: { metaAccessToken: s.metaAccessToken, metaAppSecret: s.metaAppSecret } });
    done++;
  }
  return done;
}
