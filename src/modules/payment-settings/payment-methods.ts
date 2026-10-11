import { randomUUID } from "crypto";
import { z } from "zod";

// طرق الدفع اللي التاجر بيعرضها لعملاءه - ممكن أكتر من طريقة مع بعض،
// والعميل بيختار وهو بيحجز/بيطلب:
//  - MYFATOORAH: دفع أونلاين بمفتاح التاجر، والتأكيد تلقائي
//  - LINK: لينك دفع من أي مزوّد (SADAD / Dibsy / Tap / PayTabs / Stripe...)
//  - BANK_TRANSFER: تحويل بنكي / Fawran / محفظة - بنعرض البيانات للعميل
//  - CASH: كاش عند الوصول أو الاستلام - الحجز/الأوردر بيتأكد فورًا
// كل الطرق ماعدا MyFatoorah التاجر بيأكد فيها الدفع بنفسه بزرار "Mark paid"
export const PAYMENT_METHOD_TYPES = ["MYFATOORAH", "LINK", "BANK_TRANSFER", "CASH"] as const;
export type PaymentMethodType = (typeof PAYMENT_METHOD_TYPES)[number];

export interface PaymentMethod {
  id: string;
  type: PaymentMethodType;
  label: string;
  url?: string;
  details?: string;
}

export const MAX_PAYMENT_METHODS = 10;

// اللينك لازم يكون https فقط (مفيش javascript: أو http) لأنه بيتفتح
// للعميل. {amount} و{reference} اختيارية جوه اللينك
export const httpsPaymentUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v.replace(/\{(amount|reference)\}/g, "x")).protocol === "https:";
    } catch {
      return false;
    }
  }, "Payment link must be a valid https:// URL");

const methodSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional(),
    type: z.enum(PAYMENT_METHOD_TYPES),
    label: z.string().trim().min(1).max(60),
    url: httpsPaymentUrl.optional(),
    details: z.string().trim().max(500).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === "LINK" && !m.url) ctx.addIssue({ code: "custom", path: ["url"], message: "A payment link needs its https:// link" });
    if (m.type === "BANK_TRANSFER" && !m.details)
      ctx.addIssue({ code: "custom", path: ["details"], message: "Add the account details your customers transfer to" });
  });

export const paymentMethodsInputSchema = z.object({
  methods: z.array(methodSchema).max(MAX_PAYMENT_METHODS),
});

// بينضّف اللي جاي من التاجر: id لكل طريقة، ومفيش حقول ملهاش لازمة
// (مثلاً url على طريقة كاش)
export function normalizePaymentMethods(input: z.infer<typeof paymentMethodsInputSchema>["methods"]): PaymentMethod[] {
  const seen = new Set<string>();
  return input.map((m) => {
    const id = m.id && !seen.has(m.id) ? m.id : randomUUID();
    seen.add(id);
    const out: PaymentMethod = { id, type: m.type, label: m.label };
    if (m.type === "LINK") out.url = m.url;
    if ((m.type === "BANK_TRANSFER" || m.type === "CASH") && m.details) out.details = m.details;
    return out;
  });
}

interface PaymentSettingsLike {
  methods: unknown;
  provider: string;
  customProviderName: string | null;
  customPaymentUrl: string | null;
  myFatoorahApiKey: string | null;
}

// طرق الدفع الفعلية للتاجر. methods = null معناها التاجر لسه ما استخدمش
// الشاشة الجديدة - بنحوّل إعداده القديم (طريقة واحدة) لطريقة في القايمة
// عشان محدش يتأثر. MyFatoorah من غير مفتاح متسجّل مابتظهرش للعميل
export function resolvePaymentMethods(settings: PaymentSettingsLike): PaymentMethod[] {
  if (settings.methods !== null && settings.methods !== undefined) {
    const parsed = z.array(methodSchema).safeParse(settings.methods);
    if (!parsed.success) return [];
    return parsed.data
      .filter((m) => m.id)
      .map((m) => m as PaymentMethod)
      .filter((m) => m.type !== "MYFATOORAH" || Boolean(settings.myFatoorahApiKey));
  }
  if (settings.provider === "CUSTOM_LINK" && settings.customPaymentUrl) {
    return [{ id: "legacy-link", type: "LINK", label: settings.customProviderName || "Pay online", url: settings.customPaymentUrl }];
  }
  if (settings.myFatoorahApiKey) {
    return [{ id: "legacy-myfatoorah", type: "MYFATOORAH", label: "Card / Apple Pay / Google Pay" }];
  }
  return [];
}

// اللي العميل يشوفه في الصفحة العامة: من غير اللينك نفسه (بيتبعتله بعد
// ما الحجز/الأوردر يتحفظ ومعاه رقم المرجع الصح)
export function publicPaymentMethods(methods: PaymentMethod[]) {
  return methods.map((m) => ({ id: m.id, type: m.type, label: m.label, details: m.details ?? null }));
}

// العميل اختار طريقة - لو مابعتش اختيار (أو داشبورد التاجر نفسه) بناخد
// أول طريقة. لو بعت id مش موجود بنرجّع null (طلب غلط)
export function pickPaymentMethod(methods: PaymentMethod[], methodId?: string | null): PaymentMethod | null {
  if (methods.length === 0) return null;
  if (!methodId) return methods[0];
  return methods.find((m) => m.id === methodId) ?? null;
}

export function buildPaymentLink(url: string, amount: number, reference: string) {
  return url.replace(/\{amount\}/g, encodeURIComponent(String(amount))).replace(/\{reference\}/g, encodeURIComponent(reference));
}

// رقم مرجع قصير يكتبه العميل في التحويل، ويشوفه التاجر جنب الحجز/الأوردر
export function shortReference(id: string) {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}
