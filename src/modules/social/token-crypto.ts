import crypto from "crypto";

// توكنات حسابات السوشيال بتتحفظ متشفّرة (AES-256-GCM): لو حد شاف قاعدة البيانات مايقدرش ينشر باسم التاجر.
// المفتاح: SOCIAL_TOKEN_KEY من Railway لو موجود، وإلا مشتق من JWT_REFRESH_SECRET
// (اللي مابيتغيرش أبدًا - لو اتغيّر لازم التجار يربطوا حساباتهم تاني)
function key(): Buffer {
  const secret = process.env.SOCIAL_TOKEN_KEY?.trim() || process.env.JWT_REFRESH_SECRET?.trim();
  if (!secret) throw new Error("SOCIAL_TOKEN_KEY / JWT_REFRESH_SECRET is not set");
  return crypto.createHash("sha256").update(`bluefield-social-tokens:${secret}`).digest();
}

export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptToken(stored: string): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unknown token format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
