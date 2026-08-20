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

// بينشئ فاتورة حقيقية على MyFatoorah (Hosted Payment Page - POST /v3/payments)
// وبيرجّع رابط الدفع اللي العميل المفروض يتحوّل عليه. لو مفيش مفتاح API
// متسجّل، بيرجّع خطأ صريح بدل ما يتظاهر إنه نجح - مفيش أي محاكاة هنا
export async function initiateMyFatoorahPayment(input: {
  amount: number;
  redirectionUrl: string;
}): Promise<InitiatePaymentResult> {
  const settings = await getPlatformSettings();
  if (!settings.myFatoorahApiKey) {
    return { ok: false, error: "Payment gateway is not connected yet. Contact the platform admin." };
  }

  try {
    const res = await fetch(`${baseUrl(settings.myFatoorahIsTest)}/v3/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.myFatoorahApiKey}`,
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
export async function checkMyFatoorahPaymentStatus(paymentId: string): Promise<{ paid: boolean; raw?: any }> {
  const settings = await getPlatformSettings();
  if (!settings.myFatoorahApiKey) return { paid: false };

  try {
    const res = await fetch(`${baseUrl(settings.myFatoorahIsTest)}/v3/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${settings.myFatoorahApiKey}` },
    });
    const data: any = await res.json();
    const status = data?.Data?.Invoice?.Status;
    return { paid: status === "PAID", raw: data };
  } catch {
    return { paid: false };
  }
}

export { getPlatformSettings };
