import { randomUUID } from "crypto";
import { paymentSignatureString, hmacBase64, skipcashAmount, type SkipCashPaymentFields } from "./skipcash.signature";

// بوابة SkipCash (https://dev.skipcash.app/doc/api-integration/). المفاتيح بتيجي من برّه دايمًا
// (Railway Variables للمنصة، أو مفاتيح التاجر المتشفّرة) - مفيش أي مفتاح مكتوب في الكود.
export const SKIPCASH_SANDBOX_URL = "https://skipcashtest.azurewebsites.net";
export const SKIPCASH_LIVE_URL = "https://api.skipcash.app";

export interface SkipCashCredentials {
  baseUrl: string;
  clientId: string;
  keyId: string;
  secretKey: string;
  webhookKey: string;
}

export interface SkipCashCreateInput {
  amount: number; // بالريال القطري (SkipCash بيقبض QAR بس)
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  transactionId: string;
  custom1?: string;
  returnUrl: string;
  webhookUrl?: string;
  subject?: string;
}

export interface SkipCashPaymentInfo {
  id: string;
  statusId: number;
  amount: number;
  currency: string;
  transactionId: string | null;
  visaId: string | null;
  payUrl: string | null;
}

export type SkipCashCreateResult = { ok: true; id: string; payUrl: string } | { ok: false; error: string };
export type SkipCashGetResult = { ok: true; payment: SkipCashPaymentInfo } | { ok: false; error: string };

// الواجهة اللي الخدمات بتعتمد عليها (والاختبارات بتديها نسخة وهمية)
export interface SkipCashApi {
  createPayment(creds: SkipCashCredentials, input: SkipCashCreateInput): Promise<SkipCashCreateResult>;
  getPayment(creds: SkipCashCredentials, paymentId: string): Promise<SkipCashGetResult>;
}

export const SKIPCASH_STATUS = { NEW: 0, PENDING: 1, PAID: 2, CANCELED: 3, FAILED: 4, REJECTED: 5, REFUNDED: 6, PENDING_REFUND: 7, REFUND_FAILED: 8, STARTED: 12 } as const;

function errorText(data: any, status: number): string {
  const v = data?.validationErrors;
  const validation = Array.isArray(v) ? v.map((e: any) => e?.errorMessage ?? e?.message ?? JSON.stringify(e)).join(", ") : v && typeof v === "object" ? Object.values(v).flat().join(", ") : "";
  return String(validation || data?.errorMessage || data?.error || `SkipCash answered HTTP ${status}`).slice(0, 300);
}

export function toPaymentInfo(r: any): SkipCashPaymentInfo {
  return {
    id: String(r?.id ?? ""),
    statusId: Number(r?.statusId ?? -1),
    amount: Number(r?.amount ?? NaN),
    currency: String(r?.currency ?? "QAR"),
    transactionId: r?.transactionId != null && r.transactionId !== "" ? String(r.transactionId) : null,
    visaId: r?.visaId != null && r.visaId !== "" ? String(r.visaId) : null,
    payUrl: r?.payUrl ? String(r.payUrl) : null,
  };
}

export class HttpSkipCashApi implements SkipCashApi {
  constructor(private readonly timeoutMs = 20000) {}

  async createPayment(creds: SkipCashCredentials, input: SkipCashCreateInput): Promise<SkipCashCreateResult> {
    if (!creds.keyId || !creds.secretKey) return { ok: false, error: "SkipCash is not connected yet." };
    // نفس الحقول في التوقيع وفي الـ body (Custom1 جزء من التوقيع، الباقي body بس)
    const signed: SkipCashPaymentFields = {
      Uid: randomUUID(),
      KeyId: creds.keyId,
      Amount: skipcashAmount(input.amount),
      FirstName: input.firstName,
      LastName: input.lastName,
      Phone: input.phone,
      Email: input.email,
      TransactionId: input.transactionId,
      Custom1: input.custom1,
    };
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(signed)) if (v !== undefined && v !== "") body[k] = v;
    body.ReturnUrl = input.returnUrl;
    if (input.webhookUrl) body.WebhookUrl = input.webhookUrl;
    if (input.subject) body.Subject = input.subject.slice(0, 100);
    try {
      const res = await fetch(`${creds.baseUrl}/api/v1/payments`, {
        method: "POST",
        headers: { Authorization: hmacBase64(paymentSignatureString(signed), creds.secretKey), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data: any = await res.json().catch(() => null);
      const r = data?.resultObj;
      if (!res.ok || data?.hasError || data?.hasValidationError || !r?.id || !r?.payUrl) return { ok: false, error: errorText(data, res.status) };
      return { ok: true, id: String(r.id), payUrl: String(r.payUrl) };
    } catch (err) {
      return { ok: false, error: `Could not reach SkipCash: ${(err as Error).message}` };
    }
  }

  // تفاصيل دفعة برقمها (GET /api/v1/payments/{id}) - الهيدر Authorization = Client ID
  async getPayment(creds: SkipCashCredentials, paymentId: string): Promise<SkipCashGetResult> {
    if (!creds.clientId) return { ok: false, error: "SkipCash is not connected yet." };
    if (!/^[A-Za-z0-9-]{1,64}$/.test(paymentId)) return { ok: false, error: "Invalid SkipCash payment id" };
    try {
      const res = await fetch(`${creds.baseUrl}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
        headers: { Authorization: creds.clientId },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data: any = await res.json().catch(() => null);
      if (!res.ok || data?.hasError || !data?.resultObj) return { ok: false, error: errorText(data, res.status) };
      return { ok: true, payment: toPaymentInfo(data.resultObj) };
    } catch (err) {
      return { ok: false, error: `Could not reach SkipCash: ${(err as Error).message}` };
    }
  }
}
