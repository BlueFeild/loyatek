import { describe, it, expect, vi, afterEach } from "vitest";
import { confirmsOnOrder, normalizePaymentMethods, paymentMethodsInputSchema, resolvePaymentMethods } from "../modules/payment-settings/payment-methods";
import { formatMoney, MENU_CURRENCY_CODES } from "../utils/money";
import { isEmailConfigured, isValidEmail, sendEmail } from "../utils/email";

describe("الاختيار المدموج: كاش أو تحويل", () => {
  it("لازم يكون فيه بيانات التحويل", () => {
    expect(paymentMethodsInputSchema.safeParse({ methods: [{ type: "CASH_OR_TRANSFER", label: "Cash or transfer" }] }).success).toBe(false);
    expect(
      paymentMethodsInputSchema.safeParse({ methods: [{ type: "CASH_OR_TRANSFER", label: "Cash or transfer", details: "QNB IBAN QA00" }] }).success
    ).toBe(true);
  });

  it("بيتحفظ ببيانات التحويل، ومن غير لينك", () => {
    const parsed = paymentMethodsInputSchema.parse({ methods: [{ type: "CASH_OR_TRANSFER", label: "Cash or transfer", details: "IBAN", url: "https://x.com" }] });
    const [m] = normalizePaymentMethods(parsed.methods);
    expect(m).toMatchObject({ type: "CASH_OR_TRANSFER", details: "IBAN" });
    expect(m.url).toBeUndefined();
  });

  it("بيتأكد فورًا زي الكاش (التحويل البنكي لوحده لأ)", () => {
    expect(confirmsOnOrder("CASH")).toBe(true);
    expect(confirmsOnOrder("CASH_OR_TRANSFER")).toBe(true);
    expect(confirmsOnOrder("BANK_TRANSFER")).toBe(false);
    expect(confirmsOnOrder("LINK")).toBe(false);
    expect(confirmsOnOrder(null)).toBe(false);
  });

  it("بيظهر في القايمة المتسجّلة جنب الكاش والتحويل", () => {
    const base = { provider: "MYFATOORAH", customProviderName: null, customPaymentUrl: null, myFatoorahApiKey: null };
    const saved = [
      { id: "a", type: "CASH", label: "Cash" },
      { id: "b", type: "BANK_TRANSFER", label: "Bank", details: "IBAN" },
      { id: "c", type: "CASH_OR_TRANSFER", label: "Cash or transfer", details: "IBAN" },
    ];
    expect(resolvePaymentMethods({ ...base, methods: saved }).map((m) => m.type)).toEqual(["CASH", "BANK_TRANSFER", "CASH_OR_TRANSFER"]);
  });
});

describe("عملة المنيو", () => {
  it("بتعرض المبلغ بالعملة المختارة", () => {
    expect(formatMoney(25, "QAR")).toBe("QAR 25.00");
    expect(formatMoney("10.5", "USD")).toBe("$10.50");
    expect(formatMoney(7, "EUR")).toBe("€7.00");
    expect(formatMoney(150, "EGP")).toBe("EGP 150.00");
  });

  it("كل العملات في اللستة بتتعرض من غير أخطاء", () => {
    for (const c of MENU_CURRENCY_CODES) expect(formatMoney(1, c)).toMatch(/1\.00/);
  });

  it("من غير عملة = دولار (نفس العرض القديم)", () => {
    expect(formatMoney(3)).toBe("$3.00");
    expect(formatMoney(3, null)).toBe("$3.00");
  });
});

describe("الإيميل (Resend)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("من غير مفتاح في Railway: بيتسكب بهدوء ومش بيكلّم أي سيرفر", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(isEmailConfigured()).toBe(false);
    expect(await sendEmail("owner@example.com", "Hi", "text")).toEqual({ ok: false, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("بالمفتاح: بيبعت لـ Resend بالمرسل والمستلم والنص، والـ HTML متأمّن", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "BlueField <n@example.com>");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);
    const res = await sendEmail("owner@example.com", "New booking", "Fatima <script>x</script>");
    expect(res.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: "BlueField <n@example.com>", to: ["owner@example.com"], subject: "New booking" });
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).not.toContain("<script>");
  });

  it("رفض Resend مابيوقعش السيستم", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "x@example.com");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "domain not verified" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendEmail("owner@example.com", "s", "t")).toEqual({ ok: false, error: "Resend 403" });
    warn.mockRestore();
  });

  it("التحقق من الإيميل", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});
