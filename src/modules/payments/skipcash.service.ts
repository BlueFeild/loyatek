import { randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { encryptToken, decryptToken } from "../social/token-crypto";
import { AppError } from "../../core/errors";
import {
  SKIPCASH_LIVE_URL,
  SKIPCASH_SANDBOX_URL,
  SKIPCASH_STATUS,
  type SkipCashApi,
  type SkipCashCredentials,
  type SkipCashPaymentInfo,
} from "./skipcash.gateway";
import { skipcashEmail, skipcashName, skipcashPhone, skipcashTransactionId, splitName, verifyWebhookSignature, type SkipCashWebhookPayload } from "./skipcash.signature";

// ================= أي بوابة للمنصة؟ =================
// PAYMENT_PROVIDER = skipcash | myfatoorah. الافتراضي: skipcash لو SKIPCASH_SECRET_KEY موجود، وإلا myfatoorah
export type PlatformProvider = "SKIPCASH" | "MYFATOORAH";
export function platformPaymentProvider(env: NodeJS.ProcessEnv = process.env): PlatformProvider {
  const chosen = String(env.PAYMENT_PROVIDER ?? "").trim().toLowerCase();
  if (chosen === "skipcash") return "SKIPCASH";
  if (chosen === "myfatoorah") return "MYFATOORAH";
  return env.SKIPCASH_SECRET_KEY?.trim() ? "SKIPCASH" : "MYFATOORAH";
}

// مفاتيح حساب المنصة: من Railway Variables بس
export function platformSkipCashCredentials(env: NodeJS.ProcessEnv = process.env): SkipCashCredentials {
  return {
    baseUrl: (env.SKIPCASH_BASE_URL?.trim() || SKIPCASH_SANDBOX_URL).replace(/\/+$/, ""),
    clientId: env.SKIPCASH_CLIENT_ID?.trim() ?? "",
    keyId: env.SKIPCASH_KEY_ID?.trim() ?? "",
    secretKey: env.SKIPCASH_SECRET_KEY?.trim() ?? "",
    webhookKey: env.SKIPCASH_WEBHOOK_KEY?.trim() ?? "",
  };
}

// حساب التاجر: تجربة = sandbox، حقيقي = live. SKIPCASH_MERCHANT_BASE_URL للاختبار المحلي بس (سيرفر وهمي)
export function merchantBaseUrl(isTest: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SKIPCASH_MERCHANT_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return isTest ? SKIPCASH_SANDBOX_URL : SKIPCASH_LIVE_URL;
}

// ================= تخزين مفاتيح التاجر =================
export interface MerchantSkipCashInput {
  clientId: string;
  keyId: string;
  secretKey: string;
  webhookKey: string;
  isTest: boolean;
}

export interface MerchantSkipCashStatus {
  connected: boolean;
  isTest: boolean;
  keyPreview: string | null;
  webhookToken: string | null;
}

export interface SkipCashCredentialStore {
  status(tenantId: string): Promise<MerchantSkipCashStatus>;
  credentials(tenantId: string): Promise<SkipCashCredentials | null>;
  byWebhookToken(token: string): Promise<{ tenantId: string; creds: SkipCashCredentials } | null>;
  save(tenantId: string, input: MerchantSkipCashInput): Promise<MerchantSkipCashStatus>;
  clear(tenantId: string): Promise<void>;
}

type SettingsRow = {
  tenantId: string;
  skipcashClientId: string | null;
  skipcashKeyId: string | null;
  skipcashSecretKey: string | null;
  skipcashWebhookKey: string | null;
  skipcashIsTest: boolean;
  skipcashKeyLast4: string | null;
  skipcashWebhookToken: string | null;
};

function decryptRow(row: SettingsRow): SkipCashCredentials | null {
  if (!row.skipcashClientId || !row.skipcashKeyId || !row.skipcashSecretKey || !row.skipcashWebhookKey) return null;
  try {
    return {
      baseUrl: merchantBaseUrl(row.skipcashIsTest),
      clientId: decryptToken(row.skipcashClientId),
      keyId: decryptToken(row.skipcashKeyId),
      secretKey: decryptToken(row.skipcashSecretKey),
      webhookKey: decryptToken(row.skipcashWebhookKey),
    };
  } catch {
    // مفتاح التشفير اتغيّر - التاجر لازم يحفظ مفاتيحه تاني
    return null;
  }
}

export class PrismaSkipCashCredentialStore implements SkipCashCredentialStore {
  constructor(private readonly db: PrismaClient) {}

  private async row(tenantId: string): Promise<SettingsRow | null> {
    return this.db.tenantPaymentSettings.findUnique({ where: { tenantId } });
  }

  async status(tenantId: string): Promise<MerchantSkipCashStatus> {
    const row = await this.row(tenantId);
    const connected = Boolean(row && decryptRow(row));
    return {
      connected,
      isTest: row?.skipcashIsTest ?? true,
      keyPreview: connected && row?.skipcashKeyLast4 ? `••••${row.skipcashKeyLast4}` : null,
      webhookToken: connected ? (row?.skipcashWebhookToken ?? null) : null,
    };
  }

  async credentials(tenantId: string) {
    const row = await this.row(tenantId);
    return row ? decryptRow(row) : null;
  }

  async byWebhookToken(token: string) {
    if (!/^[a-f0-9]{48}$/.test(token)) return null;
    const row = await this.db.tenantPaymentSettings.findUnique({ where: { skipcashWebhookToken: token } });
    const creds = row ? decryptRow(row) : null;
    return row && creds ? { tenantId: row.tenantId, creds } : null;
  }

  async save(tenantId: string, input: MerchantSkipCashInput) {
    const existing = await this.row(tenantId);
    const data = {
      skipcashClientId: encryptToken(input.clientId),
      skipcashKeyId: encryptToken(input.keyId),
      skipcashSecretKey: encryptToken(input.secretKey),
      skipcashWebhookKey: encryptToken(input.webhookKey),
      skipcashIsTest: input.isTest,
      skipcashKeyLast4: input.keyId.slice(-4),
      skipcashWebhookToken: existing?.skipcashWebhookToken ?? randomBytes(24).toString("hex"),
    };
    await this.db.tenantPaymentSettings.upsert({ where: { tenantId }, update: data, create: { tenantId, ...data } });
    return this.status(tenantId);
  }

  async clear(tenantId: string) {
    await this.db.tenantPaymentSettings.updateMany({
      where: { tenantId },
      data: { skipcashClientId: null, skipcashKeyId: null, skipcashSecretKey: null, skipcashWebhookKey: null, skipcashKeyLast4: null },
    });
  }
}

// ================= الخدمة =================
export interface SkipCashCustomer {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface StartPaymentInput {
  amountQar: number;
  reference: string; // رقم الطلب/الحجز عندنا -> TransactionId
  customer: SkipCashCustomer;
  returnUrl: string;
  webhookUrl: string;
  subject?: string;
  custom1?: string;
}

export type StartResult = { ok: true; paymentId: string; payUrl: string } | { ok: false; error: string };

export interface CheckExpectation {
  paymentId: string;
  amountQar?: number; // لو موجود لازم يطابق
  reference?: string; // لو SkipCash رجّعت TransactionId لازم يطابق
}

export type CheckResult =
  | { ok: true; paid: boolean; payment: SkipCashPaymentInfo; problem: string | null }
  | { ok: false; error: string };

export class SkipCashService {
  constructor(
    private readonly api: SkipCashApi,
    private readonly store: SkipCashCredentialStore,
    private readonly publicApiBaseUrl: () => string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  platformCredentials() {
    return platformSkipCashCredentials(this.env);
  }

  platformReady() {
    const c = this.platformCredentials();
    return Boolean(c.clientId && c.keyId && c.secretKey);
  }

  merchantStatus(tenantId: string) {
    return this.store.status(tenantId);
  }

  merchantCredentials(tenantId: string) {
    return this.store.credentials(tenantId);
  }

  saveMerchantKeys(tenantId: string, input: MerchantSkipCashInput) {
    return this.store.save(tenantId, input);
  }

  removeMerchantKeys(tenantId: string) {
    return this.store.clear(tenantId);
  }

  platformWebhookUrl() {
    return `${this.publicApiBaseUrl()}/api/public/payments/skipcash/webhook`;
  }

  merchantWebhookUrl(token: string) {
    return `${this.publicApiBaseUrl()}/api/public/payments/skipcash/webhook/${token}`;
  }

  async start(creds: SkipCashCredentials, input: StartPaymentInput): Promise<StartResult> {
    if (!(input.amountQar > 0)) return { ok: false, error: "Nothing to pay." };
    const phone = skipcashPhone(input.customer.phone);
    if (!phone) return { ok: false, error: "A valid phone number is needed to pay online." };
    const split = splitName(input.customer.name);
    const r = await this.api.createPayment(creds, {
      amount: input.amountQar,
      firstName: skipcashName(input.customer.firstName, split.first),
      lastName: skipcashName(input.customer.lastName, split.last),
      phone,
      email: skipcashEmail(input.customer.email, phone),
      transactionId: skipcashTransactionId(input.reference),
      custom1: input.custom1,
      returnUrl: input.returnUrl,
      webhookUrl: input.webhookUrl,
      subject: input.subject,
    });
    return r.ok ? { ok: true, paymentId: r.id, payUrl: r.payUrl } : r;
  }

  // بنسأل SkipCash نفسها عن الدفعة برقمها (مش بنصدق الرابط ولا الـ webhook لوحده)
  async check(creds: SkipCashCredentials, expect: CheckExpectation): Promise<CheckResult> {
    const r = await this.api.getPayment(creds, expect.paymentId);
    if (!r.ok) return r;
    const p = r.payment;
    let problem: string | null = null;
    if (p.id && p.id.toLowerCase() !== expect.paymentId.toLowerCase()) problem = "SkipCash answered about a different payment";
    else if (expect.reference && p.transactionId && p.transactionId !== skipcashTransactionId(expect.reference)) problem = "The payment belongs to a different order";
    else if (expect.amountQar !== undefined && !(Number.isFinite(p.amount) && Math.abs(p.amount - expect.amountQar) < 0.01)) problem = `Paid amount (${p.amount}) doesn't match the order (${expect.amountQar})`;
    else if (p.currency && p.currency.toUpperCase() !== "QAR") problem = `Unexpected currency ${p.currency}`;
    return { ok: true, paid: p.statusId === SKIPCASH_STATUS.PAID && !problem, payment: p, problem };
  }

  verifyWebhook(payload: SkipCashWebhookPayload, header: string | undefined, webhookKey: string, rawBody?: Buffer) {
    return verifyWebhookSignature(payload, header, webhookKey, rawBody);
  }

  merchantByWebhookToken(token: string) {
    return this.store.byWebhookToken(token);
  }
}

export function requirePlatformSkipCash(svc: SkipCashService) {
  if (!svc.platformReady()) throw new AppError(503, "PAYMENT_NOT_CONFIGURED", "Online payment isn't switched on yet.");
}
