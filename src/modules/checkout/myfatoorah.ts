import { prisma } from "../../config/db";
import { buildPaymentLink, resolvePaymentMethods, type PaymentMethod } from "../payment-settings/payment-methods";

// بيانات نداءات MyFatoorah الحقيقية - v3 API (v2 قديم ومتروك رسميًا،
// MyFatoorah نفسهم بيقولوا "Older versions /v2 should not be used for
// new integrations" - https://docs.myfatoorah.com/docs/v3-hosted-payment-page)
async function getPlatformSettings() {
  const existing = await prisma.platformSettings.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  return prisma.platformSettings.create({ data: { id: "singleton" } });
}

function baseUrl(isTest: boolean) {
  // MYFATOORAH_BASE_URL للاختبار المحلي بس (سيرفر MyFatoorah وهمي)
  if (process.env.MYFATOORAH_BASE_URL) return process.env.MYFATOORAH_BASE_URL.replace(/\/$/, "");
  return isTest ? "https://apitest.myfatoorah.com" : "https://api.myfatoorah.com";
}

interface InitiatePaymentResult {
  ok: boolean;
  paymentUrl?: string;
  invoiceId?: string;
  error?: string;
}

interface Credentials {
  apiKey: string;
  isTest: boolean;
}

// بينشئ فاتورة حقيقية على MyFatoorah (Hosted Payment Page - POST /v3/payments)
// وبيرجّع رابط الدفع اللي العميل المفروض يتحوّل عليه. صفحة الدفع المستضافة
// دي بتعرض تلقائيًا أي طريقة دفع مفعّلة في حساب MyFatoorah بتاع صاحب
// المفتاح (كارت، Apple Pay، Google Pay، KNET...) - من غير أي كود إضافي
// من عندنا؛ التفعيل نفسه بيتم من لوحة تحكم MyFatoorah بتاعتهم هم.
// لو مفيش مفتاح API متسجّل، بيرجّع خطأ صريح بدل ما يتظاهر إنه نجح
async function initiatePaymentWithCredentials(
  creds: Credentials,
  input: { amount: number; redirectionUrl: string; currency?: string }
): Promise<InitiatePaymentResult> {
  if (!creds.apiKey) {
    return { ok: false, error: "Payment gateway is not connected yet." };
  }

  try {
    const res = await fetch(`${baseUrl(creds.isTest)}/v3/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        PaymentMethod: "CARD",
        // العملة بتتبعت عشان المبلغ مايتحسبش بعملة حساب MyFatoorah الافتراضية
        Order: input.currency ? { Amount: input.amount, Currency: input.currency } : { Amount: input.amount },
        IntegrationUrls: { Redirection: input.redirectionUrl },
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data?.IsSuccess) {
      const validationMsg = data?.ValidationErrors?.map((v: any) => `${v.Name}: ${v.Error}`).join(", ");
      return { ok: false, error: validationMsg || data?.Message || "MyFatoorah rejected the payment request" };
    }

    return {
      ok: true,
      paymentUrl: data.Data.PaymentURL,
      invoiceId: String(data.Data.InvoiceId),
    };
  } catch (err: any) {
    return { ok: false, error: `Could not reach MyFatoorah: ${err.message}` };
  }
}

// بيتأكد من حالة دفعة حقيقية بالسؤال المباشر لـ MyFatoorah (Get Payment
// Details - GET /v3/payments/{paymentId}) - مش بيثق في أي حاجة جاية
// من المتصفح لوحدها. الـ paymentId ده بييجي من MyFatoorah نفسها لما
// بترجّع العميل بعد الدفع (مضاف كـ query param في رابط الرجوع)
async function checkPaymentStatusWithCredentials(
  creds: Credentials,
  paymentId: string
): Promise<{ paid: boolean; raw?: any }> {
  if (!creds.apiKey) return { paid: false };

  try {
    const res = await fetch(`${baseUrl(creds.isTest)}/v3/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    const data: any = await res.json().catch(() => null);
    // الحالة ممكن تيجي في أكتر من مكان وبأكتر من شكل ("PAID" / "Paid")
    const status = String(data?.Data?.Invoice?.Status ?? data?.Data?.InvoiceStatus ?? "").toUpperCase();
    if (res.ok && status) return { paid: status === "PAID", raw: data };
    // رد v3 مش واضح -> نسأل بالطريقة التانية (GetPaymentStatus برقم الدفع)
    const v2 = await getPaymentStatusV2(creds, paymentId, "PaymentId");
    return v2.status ? { paid: v2.paid, raw: v2.raw } : { paid: false, raw: data };
  } catch {
    return { paid: false };
  }
}

// حالة الفاتورة برقمها (اللي إحنا عاملينها ومتخزن عندنا) - مش محتاجة إن
// العميل يرجع للموقع بعد الدفع. GetPaymentStatus بيدعم KeyType = InvoiceId
async function getPaymentStatusV2(creds: Credentials, key: string, keyType: "InvoiceId" | "PaymentId") {
  try {
    const res = await fetch(`${baseUrl(creds.isTest)}/v2/GetPaymentStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({ Key: key, KeyType: keyType }),
    });
    const data: any = await res.json().catch(() => null);
    const status = String(data?.Data?.InvoiceStatus ?? "");
    const tx = (data?.Data?.InvoiceTransactions ?? []) as any[];
    const okTx = tx.find((t) => /succ/i.test(String(t?.TransactionStatus ?? "")));
    return {
      status,
      paid: status.toUpperCase() === "PAID",
      invoiceId: data?.Data?.InvoiceId != null ? String(data.Data.InvoiceId) : null,
      paymentId: okTx?.PaymentId != null ? String(okTx.PaymentId) : null,
      error: !res.ok || data?.IsSuccess === false ? (data?.Message ?? `HTTP ${res.status}`) : null,
      raw: data,
    };
  } catch (err: any) {
    return { status: "", paid: false, invoiceId: null, paymentId: null, error: `Could not reach MyFatoorah: ${err.message}`, raw: null };
  }
}

// للمنصة: الفاتورة دي اتدفعت؟ (بنسأل برقم فاتورتنا نفسها، فمفيش احتمال إن
// الدفعة تخص طلب تاني)
export async function checkPlatformInvoice(invoiceId: string) {
  const settings = await getPlatformSettings();
  if (!settings.myFatoorahApiKey) return { status: "", paid: false, invoiceId: null, paymentId: null, error: "Payment gateway is not connected", raw: null };
  return getPaymentStatusV2({ apiKey: settings.myFatoorahApiKey, isTest: settings.myFatoorahIsTest }, invoiceId, "InvoiceId");
}

// الدفعة دي تخص الفاتورة دي فعلًا؟ (عشان محدش يدفع طلب صغير ويستخدم رقم الدفع
// ده لتأكيد طلب أكبر). "unknown" = MyFatoorah مارجّعتش رقم فاتورة نقارن بيه
export function paymentInvoiceMatch(raw: any, invoiceId: string | null | undefined): "match" | "mismatch" | "unknown" {
  const ids = [raw?.Data?.Invoice?.Id, raw?.Data?.Invoice?.InvoiceId, raw?.Data?.InvoiceId]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .map((v) => String(v));
  if (!invoiceId || ids.length === 0) return "unknown";
  return ids.includes(String(invoiceId)) ? "match" : "mismatch";
}

// المبلغ اللي اتدفع = مبلغ الطلب؟ (لو MyFatoorah مارجّعتش رقم الفاتورة،
// المبلغ بيأكد إن الدفعة دي بتاعة الطلب ده). "unknown" = مفيش مبلغ في الرد
export function paymentAmountMatch(raw: any, amount: number): "match" | "mismatch" | "unknown" {
  const values = [raw?.Data?.Amount?.Value, raw?.Data?.Invoice?.Value, raw?.Data?.InvoiceValue, raw?.Data?.Transaction?.Amount?.Value]
    .map((v) => (v && typeof v === "object" ? v.Value : v))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (values.length === 0) return "unknown";
  return values.some((v) => Math.abs(v - amount) < 0.01) ? "match" : "mismatch";
}

// --- استخدام المنصة (اشتراكات الشركات نفسها - PlatformSettings) ---

export async function initiateMyFatoorahPayment(input: {
  amount: number;
  redirectionUrl: string;
  currency?: string;
}): Promise<InitiatePaymentResult> {
  const settings = await getPlatformSettings();
  return initiatePaymentWithCredentials(
    { apiKey: settings.myFatoorahApiKey ?? "", isTest: settings.myFatoorahIsTest },
    input
  );
}

export async function checkMyFatoorahPaymentStatus(paymentId: string): Promise<{ paid: boolean; raw?: any }> {
  const settings = await getPlatformSettings();
  return checkPaymentStatusWithCredentials(
    { apiKey: settings.myFatoorahApiKey ?? "", isTest: settings.myFatoorahIsTest },
    paymentId
  );
}

// --- استخدام كل تاجر لوحده (حجوزات وأوردرات الكتالوج - TenantPaymentSettings) ---

export async function getOrCreateTenantPaymentSettings(tenantId: string) {
  const existing = await prisma.tenantPaymentSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.tenantPaymentSettings.create({ data: { tenantId } });
}

export async function initiateTenantMyFatoorahPayment(
  tenantId: string,
  input: { amount: number; redirectionUrl: string }
): Promise<InitiatePaymentResult> {
  const settings = await getOrCreateTenantPaymentSettings(tenantId);
  return initiatePaymentWithCredentials(
    { apiKey: settings.myFatoorahApiKey ?? "", isTest: settings.myFatoorahIsTest },
    input
  );
}

export async function checkTenantMyFatoorahPaymentStatus(
  tenantId: string,
  paymentId: string
): Promise<{ paid: boolean; raw?: any }> {
  const settings = await getOrCreateTenantPaymentSettings(tenantId);
  return checkPaymentStatusWithCredentials(
    { apiKey: settings.myFatoorahApiKey ?? "", isTest: settings.myFatoorahIsTest },
    paymentId
  );
}

// كل طرق الدفع اللي التاجر مفعّلها (بما فيها إعداده القديم لو لسه ما
// استخدمش الشاشة الجديدة)
export async function getTenantPaymentMethods(tenantId: string): Promise<PaymentMethod[]> {
  return resolvePaymentMethods(await getOrCreateTenantPaymentSettings(tenantId));
}

// نقطة دخول موحّدة لدفع التاجر حسب الطريقة اللي العميل اختارها:
//  - MyFatoorah: بنكلّم API بتاعها (تأكيد تلقائي)
//  - لينك: بنرجّع لينك التاجر بعد استبدال {amount} و{reference}
//  - تحويل بنكي / كاش: مفيش لينك - العميل بيشوف التعليمات، والتاجر بيأكد
export async function startTenantPayment(
  tenantId: string,
  method: PaymentMethod,
  input: { amount: number; redirectionUrl: string; reference: string }
): Promise<InitiatePaymentResult> {
  if (method.type === "MYFATOORAH") return initiateTenantMyFatoorahPayment(tenantId, input);
  if (method.type === "LINK") {
    if (!method.url) return { ok: false, error: "The business hasn't set up its payment link yet." };
    return { ok: true, paymentUrl: buildPaymentLink(method.url, input.amount, input.reference) };
  }
  return { ok: true };
}

export { getPlatformSettings };
