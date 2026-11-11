import { createHash, randomInt, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { AppError, ValidationError } from "../../core/errors";
import { WA_LOGIN_LIMITS, type OtpSender, type WaLoginSource, type WaLoginStore } from "./wa-login.types";

// منطق الدخول بالواتساب: كود 6 أرقام (متخزّن hash بس) يوصل على واتساب التاجر،
// صالح 5 دقايق، 5 محاولات، وحدود إرسال لكل رقم ولكل جهاز. لما يتأكد بنرجّع
// توكن موقّع (30 يوم) فيه رقم العميل والشركة - صفحة الحجز أو موقع التاجر بيستخدموه.
export class WaLoginService {
  constructor(
    private readonly store: WaLoginStore,
    private readonly sender: OtpSender,
    private readonly secret: () => string,
    private readonly now: () => Date = () => new Date()
  ) {}

  static normalizePhone(raw: string): string {
    const digits = String(raw ?? "").replace(/[^\d]/g, "").replace(/^00/, "");
    if (digits.length < 8 || digits.length > 15) throw new ValidationError("Enter your WhatsApp number with the country code, like +974 5555 1234.");
    return digits;
  }

  private hash(tenantId: string, phone: string, code: string) {
    return createHash("sha256").update(`${tenantId}:${phone}:${code}`).digest("hex");
  }

  async start(input: { tenantId: string; phone: string; ip: string | null; source: WaLoginSource }) {
    const settings = await this.store.settings(input.tenantId);
    if (!settings.enabled && input.source !== "test") throw new AppError(403, "WA_LOGIN_OFF", "WhatsApp login isn't switched on for this business.");
    const phone = WaLoginService.normalizePhone(input.phone);
    const now = this.now();
    const since = new Date(now.getTime() - WA_LOGIN_LIMITS.windowMs);
    const [byPhone, byIp] = await Promise.all([
      this.store.countCodesSince(input.tenantId, { phone }, since),
      input.ip ? this.store.countCodesSince(input.tenantId, { ip: input.ip }, since) : Promise.resolve(0),
    ]);
    if (byPhone >= WA_LOGIN_LIMITS.perPhone || byIp >= WA_LOGIN_LIMITS.perIp) {
      throw new AppError(429, "TOO_MANY_CODES", "Too many codes were sent. Please wait a few minutes and try again.");
    }
    const code = String(randomInt(0, 10 ** WA_LOGIN_LIMITS.codeLength)).padStart(WA_LOGIN_LIMITS.codeLength, "0");
    const id = await this.store.createCode({
      tenantId: input.tenantId,
      phone,
      codeHash: this.hash(input.tenantId, phone, code),
      expiresAt: new Date(now.getTime() + WA_LOGIN_LIMITS.ttlMs),
      ip: input.ip,
      source: input.source,
    });
    const sent = await this.sender.send(input.tenantId, phone, code, settings.templateLang);
    if (!sent.ok) {
      // الكود ماوصلش - مايتحسبش من الحد
      await this.store.deleteCode(id);
      throw new AppError(502, sent.code ?? "WA_SEND_FAILED", sent.error);
    }
    return { phone, expiresInSeconds: WA_LOGIN_LIMITS.ttlMs / 1000 };
  }

  async verify(input: { tenantId: string; phone: string; code: string }) {
    const phone = WaLoginService.normalizePhone(input.phone);
    const code = String(input.code ?? "").replace(/\D/g, "");
    if (code.length !== WA_LOGIN_LIMITS.codeLength) throw new ValidationError(`The code has ${WA_LOGIN_LIMITS.codeLength} numbers.`);
    const now = this.now();
    const row = await this.store.latestOpenCode(input.tenantId, phone, now);
    if (!row) throw new AppError(400, "CODE_EXPIRED", "This code expired. Ask for a new one.");
    if (!(await this.store.addAttempt(row.id, WA_LOGIN_LIMITS.maxAttempts))) {
      throw new AppError(429, "TOO_MANY_TRIES", "Too many wrong tries. Ask for a new code.");
    }
    const a = Buffer.from(this.hash(input.tenantId, phone, code), "hex");
    const b = Buffer.from(row.codeHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(400, "WRONG_CODE", "That code isn't right. Check the WhatsApp message and try again.");
    if (!(await this.store.markUsed(row.id, now))) throw new AppError(400, "CODE_EXPIRED", "This code was already used. Ask for a new one.");
    const token = jwt.sign({ t: input.tenantId, p: phone }, this.secret(), { audience: "wa-login", expiresIn: `${WA_LOGIN_LIMITS.tokenDays}d` });
    return { token, phone };
  }

  // التوكن ده بتاع الشركة دي فعلًا؟ بيرجّع رقم العميل أو null
  readToken(tenantId: string, token: string | undefined | null): string | null {
    if (!token) return null;
    try {
      const data = jwt.verify(token, this.secret(), { audience: "wa-login" }) as { t?: string; p?: string };
      return data.t === tenantId && data.p ? data.p : null;
    } catch {
      return null;
    }
  }

  // نفس الرقم؟ (بالأرقام بس، أو آخر 8 أرقام لو حد كتب الرقم من غير كود الدولة)
  static samePhone(a: string, b: string): boolean {
    const x = a.replace(/\D/g, "");
    const y = b.replace(/\D/g, "");
    return x === y || (x.length >= 8 && y.length >= 8 && x.slice(-8) === y.slice(-8));
  }
}
