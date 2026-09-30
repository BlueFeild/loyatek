import { prisma } from "../../config/db";

// بيانات نداءات MyFatoorah الحقيقية - v3 API (v2 قديم ومتروك رسميًا،
// MyFatoorah نفسهم بيقولوا "Older versions /v2 should not be used for
// new integrations" - https://docs.myfatoorah.com/docs/v3-hosted-payment-page)
async function getPlatformSettings() {
  const existing = await prisma.platformSettings.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  return prisma.platformSettings.create({ data: { id: "singleton" } });
}

function baseUrl(isTest: boolean) {
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
  input: { amount: number; redirectionUrl: string }
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
        Order: { Amount: input.amount },
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
    const data: any = await res.json();
    const status = data?.Data?.Invoice?.Status;
    return { paid: status === "PAID", raw: data };
  } catch {
    return { paid: false };
  }
}

// --- استخدام المنصة (اشتراكات الشركات نفسها - PlatformSettings) ---

export async function initiateMyFatoorahPayment(input: {
  amount: number;
  redirectionUrl: string;
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

export { getPlatformSettings };
