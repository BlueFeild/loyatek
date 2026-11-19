import { describe, expect, it } from "vitest";
import {
  paymentSignatureString,
  signPayment,
  webhookSignatureString,
  verifyWebhookSignature,
  hmacBase64,
  skipcashPhone,
  skipcashAmount,
  skipcashTransactionId,
  skipcashEmail,
  splitName,
} from "../modules/payments/skipcash.signature";
import { platformPaymentProvider, platformSkipCashCredentials, merchantBaseUrl, SkipCashService, type SkipCashCredentialStore } from "../modules/payments/skipcash.service";
import type { SkipCashApi, SkipCashCreateInput, SkipCashCredentials } from "../modules/payments/skipcash.gateway";
import { isAutoGateway, resolvePaymentMethods, PAYMENT_METHOD_TYPES } from "../modules/payment-settings/payment-methods";

// قيم تجريبية بس (مش مفاتيح حقيقية)
const creds: SkipCashCredentials = { baseUrl: "http://fake", clientId: "client-x", keyId: "key-123", secretKey: "test-secret", webhookKey: "wh-key" };

describe("SkipCash payment signature (doc order: Uid, KeyId, Amount, FirstName, LastName, Phone, Email, Street…, TransactionId, Custom1)", () => {
  const fields = {
    Uid: "11111111-2222-3333-4444-555555555555",
    KeyId: "key-123",
    Amount: "10.50",
    FirstName: "Sara",
    LastName: "Ali",
    Phone: "+97455551234",
    Email: "sara@example.com",
    Street: "",
    TransactionId: "ORDER1",
  };

  it("joins non-empty Key=Value pairs with commas in the documented order", () => {
    // ترتيب الإدخال مختلف عن ترتيب المستند عمدًا
    const shuffled = { TransactionId: "ORDER1", Email: fields.Email, Uid: fields.Uid, Amount: "10.50", KeyId: "key-123", Phone: fields.Phone, LastName: "Ali", FirstName: "Sara", City: "" };
    expect(paymentSignatureString(shuffled)).toBe(
      "Uid=11111111-2222-3333-4444-555555555555,KeyId=key-123,Amount=10.50,FirstName=Sara,LastName=Ali,Phone=+97455551234,Email=sara@example.com,TransactionId=ORDER1"
    );
  });

  it("HMAC-SHA256 + Base64 matches an independently computed value (openssl)", () => {
    expect(signPayment(fields, "test-secret")).toBe("absKBMO0mZoNCPpS1wcM3DdX0hiIS4hVmcCj3xqgdLo=");
  });

  it("Custom1 goes last, after TransactionId", () => {
    expect(paymentSignatureString({ Custom1: "c", TransactionId: "t", Uid: "u" })).toBe("Uid=u,TransactionId=t,Custom1=c");
  });
});

describe("SkipCash webhook signature (PaymentId, Amount, StatusId, TransactionId?, Custom1?, VisaId)", () => {
  const payload = { PaymentId: "abc-1", Amount: "1.00", StatusId: 2, TransactionId: "ORDER1", Custom1: null, VisaId: "V9", CardType: "Credit Card" };
  const good = "Jr8C8RGOwK0gf0QKCoRPte4EfxxaMP9oDqTWxZ1lAwo=";

  it("builds the string without the empty Custom1", () => {
    expect(webhookSignatureString(payload)).toBe("PaymentId=abc-1,Amount=1.00,StatusId=2,TransactionId=ORDER1,VisaId=V9");
  });

  it("accepts the right signature (openssl value) and rejects wrong key / tampered amount / missing header", () => {
    expect(verifyWebhookSignature(payload, good, "wh-key")).toBe(true);
    expect(verifyWebhookSignature(payload, good, "other-key")).toBe(false);
    expect(verifyWebhookSignature({ ...payload, Amount: "100.00" }, good, "wh-key")).toBe(false);
    expect(verifyWebhookSignature({ ...payload, StatusId: 4 }, good, "wh-key")).toBe(false);
    expect(verifyWebhookSignature(payload, undefined, "wh-key")).toBe(false);
    expect(verifyWebhookSignature(payload, good, "")).toBe(false);
  });

  it("matches when Amount arrives as a JSON number (uses the raw text from the body)", () => {
    const raw = Buffer.from('{"PaymentId":"abc-1","Amount":1.00,"StatusId":2,"TransactionId":"ORDER1","VisaId":"V9"}');
    const parsed = JSON.parse(raw.toString());
    expect(parsed.Amount).toBe(1);
    expect(verifyWebhookSignature(parsed, good, "wh-key", raw)).toBe(true);
  });

  it("omits TransactionId when it's empty", () => {
    const p = { PaymentId: "x", Amount: "5.00", StatusId: 3, TransactionId: "", VisaId: "v" };
    expect(webhookSignatureString(p)).toBe("PaymentId=x,Amount=5.00,StatusId=3,VisaId=v");
    expect(verifyWebhookSignature(p, hmacBase64("PaymentId=x,Amount=5.00,StatusId=3,VisaId=v", "k"), "k")).toBe(true);
  });
});

describe("SkipCash field cleaning", () => {
  it("amount = 2 decimals with a dot", () => {
    expect(skipcashAmount(10)).toBe("10.00");
    expect(skipcashAmount(16.005)).toBe("16.01");
    expect(skipcashAmount(0.1 + 0.2)).toBe("0.30");
  });
  it("phone keeps + and digits, 00 → +, Qatari 8 digits allowed, junk refused", () => {
    expect(skipcashPhone("+974 5555 1234")).toBe("+97455551234");
    expect(skipcashPhone("0097455551234")).toBe("+97455551234");
    expect(skipcashPhone("55551234")).toBe("55551234");
    expect(skipcashPhone("123")).toBeNull();
    expect(skipcashPhone("")).toBeNull();
    expect(skipcashPhone("+1234567890123456")).toBeNull();
  });
  it("transaction id has no special characters and max 40", () => {
    expect(skipcashTransactionId("3f2a-11#22")).toBe("3f2a1122");
    expect(skipcashTransactionId("a".repeat(60))).toHaveLength(40);
  });
  it("names: no symbols, Arabic kept, one-word name repeated as last name", () => {
    expect(splitName("Sara  Al-Ali")).toEqual({ first: "Sara", last: "Al Ali" });
    expect(splitName("محمد")).toEqual({ first: "محمد", last: "محمد" });
    expect(splitName("!!!")).toEqual({ first: "Customer", last: "Customer" });
  });
  it("email falls back to phone@domain when missing", () => {
    expect(skipcashEmail("a@b.co", "+97455551234")).toBe("a@b.co");
    expect(skipcashEmail("", "+97455551234")).toBe("97455551234@blue-field.co");
  });
});

describe("provider choice + credentials from env only", () => {
  it("PAYMENT_PROVIDER wins, else SkipCash when its secret is set, else MyFatoorah", () => {
    expect(platformPaymentProvider({ PAYMENT_PROVIDER: "myfatoorah", SKIPCASH_SECRET_KEY: "x" })).toBe("MYFATOORAH");
    expect(platformPaymentProvider({ PAYMENT_PROVIDER: "SkipCash" })).toBe("SKIPCASH");
    expect(platformPaymentProvider({ SKIPCASH_SECRET_KEY: "x" })).toBe("SKIPCASH");
    expect(platformPaymentProvider({})).toBe("MYFATOORAH");
  });
  it("base URL defaults to the sandbox; merchant live/test", () => {
    expect(platformSkipCashCredentials({}).baseUrl).toBe("https://skipcashtest.azurewebsites.net");
    expect(platformSkipCashCredentials({ SKIPCASH_BASE_URL: "https://api.skipcash.app/" }).baseUrl).toBe("https://api.skipcash.app");
    expect(merchantBaseUrl(false, {})).toBe("https://api.skipcash.app");
    expect(merchantBaseUrl(true, {})).toBe("https://skipcashtest.azurewebsites.net");
  });
});

describe("payment methods list", () => {
  it("SKIPCASH is a method type and an automatic gateway", () => {
    expect(PAYMENT_METHOD_TYPES).toContain("SKIPCASH");
    expect(isAutoGateway("SKIPCASH")).toBe(true);
    expect(isAutoGateway("CASH")).toBe(false);
  });
  it("hides SkipCash from customers until the merchant's keys are saved", () => {
    const methods = [{ id: "a", type: "SKIPCASH", label: "Card" }, { id: "b", type: "CASH", label: "Cash" }];
    const base = { methods, provider: "MYFATOORAH", customProviderName: null, customPaymentUrl: null, myFatoorahApiKey: null };
    expect(resolvePaymentMethods({ ...base, skipcashSecretKey: null }).map((m) => m.type)).toEqual(["CASH"]);
    expect(resolvePaymentMethods({ ...base, skipcashSecretKey: "v1:enc" }).map((m) => m.type)).toEqual(["SKIPCASH", "CASH"]);
  });
});

// SkipCash وهمي للاختبار
class FakeApi implements SkipCashApi {
  created: SkipCashCreateInput[] = [];
  payment = { id: "pay-1", statusId: 2, amount: 50, currency: "QAR", transactionId: "order1", visaId: "v", payUrl: null as string | null };
  async createPayment(_c: SkipCashCredentials, input: SkipCashCreateInput) {
    this.created.push(input);
    return { ok: true as const, id: "pay-1", payUrl: "https://pay.example/pay-1" };
  }
  async getPayment() {
    return { ok: true as const, payment: { ...this.payment } };
  }
}
const noStore = {} as SkipCashCredentialStore;

describe("SkipCashService", () => {
  it("start: cleans the customer fields and refuses without a phone", async () => {
    const api = new FakeApi();
    const svc = new SkipCashService(api, noStore, () => "https://api.test");
    const r = await svc.start(creds, { amountQar: 50, reference: "order-1", customer: { name: "Sara Ali", phone: "+974 5555 1234" }, returnUrl: "https://x/ret", webhookUrl: "https://x/wh" });
    expect(r).toEqual({ ok: true, paymentId: "pay-1", payUrl: "https://pay.example/pay-1" });
    expect(api.created[0]).toMatchObject({ amount: 50, firstName: "Sara", lastName: "Ali", phone: "+97455551234", email: "97455551234@blue-field.co", transactionId: "order1" });
    const bad = await svc.start(creds, { amountQar: 50, reference: "o", customer: { name: "x" }, returnUrl: "r", webhookUrl: "w" });
    expect(bad.ok).toBe(false);
    expect(api.created).toHaveLength(1);
  });

  it("check: paid only when status=2, same payment, same order and same amount", async () => {
    const api = new FakeApi();
    const svc = new SkipCashService(api, noStore, () => "");
    const ok = await svc.check(creds, { paymentId: "pay-1", amountQar: 50, reference: "order-1" });
    expect(ok.ok && ok.paid).toBe(true);
    const wrongAmount = await svc.check(creds, { paymentId: "pay-1", amountQar: 60, reference: "order-1" });
    expect(wrongAmount.ok && wrongAmount.paid).toBe(false);
    expect(wrongAmount.ok && wrongAmount.problem).toMatch(/amount/);
    const otherOrder = await svc.check(creds, { paymentId: "pay-1", amountQar: 50, reference: "order-2" });
    expect(otherOrder.ok && otherOrder.paid).toBe(false);
    api.payment.statusId = 12;
    const started = await svc.check(creds, { paymentId: "pay-1", amountQar: 50 });
    expect(started.ok && started.paid).toBe(false);
    api.payment = { ...api.payment, statusId: 2, id: "pay-9" };
    const otherPayment = await svc.check(creds, { paymentId: "pay-1" });
    expect(otherPayment.ok && otherPayment.paid).toBe(false);
  });
});
