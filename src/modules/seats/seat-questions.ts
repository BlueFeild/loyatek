import { z } from "zod";

// أسئلة التاجر للعميل وقت الحجز (منطق نقي): نص حر أو اختيار من قايمة
export const questionSchema = z.object({
  id: z.string().trim().min(1).max(24).regex(/^[a-z0-9_-]+$/i),
  label: z.string().trim().min(1).max(120),
  required: z.boolean().default(false),
  // فاضية = العميل يكتب، غير كده يختار واحدة
  options: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
});
export const questionsSchema = z.array(questionSchema).max(5).superRefine((list, ctx) => {
  if (new Set(list.map((q) => q.id)).size !== list.length) ctx.addIssue({ code: "custom", message: "Two questions have the same id" });
});
export type SeatQuestion = z.infer<typeof questionSchema>;

export function readQuestions(value: unknown): SeatQuestion[] {
  const r = questionsSchema.safeParse(value);
  return r.success ? r.data : [];
}

// بيرجّع الإجابات النضيفة (الأسئلة المعروفة بس) أو رسالة غلط
export function checkAnswers(questions: SeatQuestion[], raw: Record<string, unknown> | undefined): { ok: true; answers: Record<string, string> | null } | { ok: false; error: string } {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const v = raw?.[q.id];
    const text = typeof v === "string" ? v.trim().slice(0, 300) : "";
    if (!text) {
      if (q.required) return { ok: false, error: `Please answer: ${q.label}` };
      continue;
    }
    if (q.options.length && !q.options.includes(text)) return { ok: false, error: `Please choose an answer for: ${q.label}` };
    answers[q.id] = text;
  }
  return { ok: true, answers: Object.keys(answers).length ? answers : null };
}
