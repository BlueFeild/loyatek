import { describe, it, expect } from "vitest";
import {
  resolvePaymentMethods,
  publicPaymentMethods,
  pickPaymentMethod,
  buildPaymentLink,
  shortReference,
  normalizePaymentMethods,
  paymentMethodsInputSchema,
} from "../modules/payment-settings/payment-methods";

const base = { methods: null, provider: "MYFATOORAH", customProviderName: null, customPaymentUrl: null, myFatoorahApiKey: null };

describe("طرق الدفع المتعددة للتاجر", () => {
  it("التاجر القديم بلينك واحد بيتحوّل لطريقة واحدة من غير ما يتأثر", () => {
    const methods = resolvePaymentMethods({ ...base, provider: "CUSTOM_LINK", customProviderName: "SADAD", customPaymentUrl: "https://pay.sadad.qa/x?amt={amount}" });
    expect(methods).toEqual([{ id: "legacy-link", type: "LINK", label: "SADAD", url: "https://pay.sadad.qa/x?amt={amount}" }]);
  });

  it("التاجر القديم بمفتاح MyFatoorah بس بيتحوّل لطريقة MyFatoorah", () => {
    const methods = resolvePaymentMethods({ ...base, myFatoorahApiKey: "secret-key-123" });
    expect(methods.map((m) => m.type)).toEqual(["MYFATOORAH"]);
  });

  it("من غير أي إعداد = مفيش طرق دفع", () => {
    expect(resolvePaymentMethods(base)).toEqual([]);
  });

  it("القايمة الجديدة بتتقري زي ما هي، وMyFatoorah من غير مفتاح مابتظهرش", () => {
    const saved = [
      { id: "a", type: "CASH", label: "Cash on arrival" },
      { id: "b", type: "MYFATOORAH", label: "Card" },
      { id: "c", type: "BANK_TRANSFER", label: "Fawran", details: "QNB 1234" },
    ];
    expect(resolvePaymentMethods({ ...base, methods: saved }).map((m) => m.id)).toEqual(["a", "c"]);
    expect(resolvePaymentMethods({ ...base, methods: saved, myFatoorahApiKey: "k".repeat(12) }).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("قايمة فاضية متسجّلة = التاجر شال كل الطرق (مانرجعش للإعداد القديم)", () => {
    expect(resolvePaymentMethods({ ...base, methods: [], provider: "CUSTOM_LINK", customPaymentUrl: "https://x.com" })).toEqual([]);
  });

  it("الصفحة العامة مابتكشفش اللينك نفسه", () => {
    const pub = publicPaymentMethods([{ id: "l", type: "LINK", label: "Tap", url: "https://tap.company/pay" }]);
    expect(pub).toEqual([{ id: "l", type: "LINK", label: "Tap", details: null }]);
    expect(JSON.stringify(pub)).not.toContain("tap.company");
  });

  it("اختيار الطريقة: id صح / مفيش id = أول طريقة / id غلط = null", () => {
    const methods = [
      { id: "a", type: "CASH" as const, label: "Cash" },
      { id: "b", type: "BANK_TRANSFER" as const, label: "Bank", details: "IBAN" },
    ];
    expect(pickPaymentMethod(methods, "b")?.id).toBe("b");
    expect(pickPaymentMethod(methods)?.id).toBe("a");
    expect(pickPaymentMethod(methods, "hacked")).toBeNull();
    expect(pickPaymentMethod([], "a")).toBeNull();
  });

  it("اللينك بيتملا بالمبلغ ورقم المرجع", () => {
    expect(buildPaymentLink("https://p.com/pay?a={amount}&r={reference}", 150.5, "ab c")).toBe("https://p.com/pay?a=150.5&r=ab%20c");
  });

  it("رقم المرجع القصير ثابت ومقروء", () => {
    expect(shortReference("0f3a9c2e-1111-2222-3333-444455556666")).toBe("0F3A9C2E");
  });

  it("الحفظ: لينك من غير https مرفوض، وتحويل بنكي من غير بيانات مرفوض", () => {
    expect(paymentMethodsInputSchema.safeParse({ methods: [{ type: "LINK", label: "X", url: "http://insecure.com" }] }).success).toBe(false);
    expect(paymentMethodsInputSchema.safeParse({ methods: [{ type: "LINK", label: "X", url: "javascript:alert(1)" }] }).success).toBe(false);
    expect(paymentMethodsInputSchema.safeParse({ methods: [{ type: "BANK_TRANSFER", label: "Bank" }] }).success).toBe(false);
    expect(paymentMethodsInputSchema.safeParse({ methods: [{ type: "CASH", label: "Cash" }] }).success).toBe(true);
  });

  it("الحفظ: كل طريقة بتاخد id، والـ ids المكررة بتتغير، والحقول الزيادة بتتشال", () => {
    const parsed = paymentMethodsInputSchema.parse({
      methods: [
        { id: "same", type: "CASH", label: "Cash", url: "https://ignored.com" },
        { id: "same", type: "LINK", label: "SADAD", url: "https://sadad.qa/p", details: "ignored" },
        { type: "BANK_TRANSFER", label: "Fawran", details: "QNB 1234" },
      ],
    });
    const out = normalizePaymentMethods(parsed.methods);
    expect(new Set(out.map((m) => m.id)).size).toBe(3);
    expect(out[0]).toEqual({ id: "same", type: "CASH", label: "Cash" });
    expect(out[1]).toMatchObject({ type: "LINK", url: "https://sadad.qa/p" });
    expect(out[1].details).toBeUndefined();
    expect(out[2].details).toBe("QNB 1234");
  });
});
