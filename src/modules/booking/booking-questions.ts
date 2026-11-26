import { z } from "zod";

// أسئلة صفحة الحجز: التاجر بيسأل العميل سؤال باختيارات قبل الحجز
// (نوع الحيوان، حجم العربية، أول زيارة ولا متابعة، المستوى...)، وكل اختيار
// ممكن يزوّد السعر. الإجمالي بيتحسب هنا على السيرفر بس.
export const MAX_QUESTIONS = 3;
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);

export const questionOptionSchema = z
  .object({
    id: ID,
    label: z.string().trim().min(1).max(60),
    // زيادة على السعر بالدولار (0 = من غير زيادة)
    priceUsd: z.number().min(0).max(100_000).optional(),
  })
  .strict();

export const questionSchema = z
  .object({
    id: ID,
    label: z.string().trim().min(1).max(80),
    required: z.boolean().optional(),
    options: z.array(questionOptionSchema).min(2).max(10),
  })
  .strict()
  .refine((q) => new Set(q.options.map((o) => o.id)).size === q.options.length, "Two choices have the same id");

export const questionsSchema = z
  .array(questionSchema)
  .max(MAX_QUESTIONS)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, "Two questions have the same id");

export type BookingQuestion = z.infer<typeof questionSchema>;
export type BookingAnswer = { question: string; answer: string; priceUsd: number };

export const answersInputSchema = z.record(z.string().max(24), z.string().max(24)).optional();

// أي JSON من قاعدة البيانات -> أسئلة سليمة (غلط = مفيش أسئلة)
export function readQuestions(raw: unknown): BookingQuestion[] {
  const p = questionsSchema.safeParse(raw ?? []);
  return p.success ? p.data : [];
}

// إجابات العميل {questionId: optionId} -> نص الإجابات + الزيادة على السعر.
// سؤال إجباري من غير إجابة أو اختيار مش موجود = خطأ واضح للعميل.
export function resolveAnswers(raw: unknown, input: Record<string, string> | undefined): { answers: BookingAnswer[]; extraUsd: number } {
  const answers: BookingAnswer[] = [];
  let extra = 0;
  for (const q of readQuestions(raw)) {
    const picked = input?.[q.id];
    if (!picked) {
      if (q.required) throw new Error(`Please answer: ${q.label}`);
      continue;
    }
    const opt = q.options.find((o) => o.id === picked);
    if (!opt) throw new Error(`Please choose one of the answers for: ${q.label}`);
    const price = Math.round((opt.priceUsd ?? 0) * 1e6) / 1e6;
    extra += price;
    answers.push({ question: q.label, answer: opt.label, priceUsd: price });
  }
  return { answers, extraUsd: Math.round(extra * 1e6) / 1e6 };
}

// "Pet: Cat · Size: SUV" للرسايل والإشعارات
export function answersText(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((a): a is BookingAnswer => !!a && typeof a === "object" && typeof (a as BookingAnswer).answer === "string")
    .map((a) => `${a.question}: ${a.answer}`)
    .join(" · ");
}
