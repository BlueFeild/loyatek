// قالب رسالة بيكتبه التاجر بنفسه: أي {اسم} بيتبدّل بقيمته، وأي متغير
// التاجر مكتبوش في رسالته ببساطة مش بيظهر (مثلاً رسالة من غير {total}
// = من غير مبلغ). المتغيرات المجهولة بتتشال بدل ما تظهر بين أقواس.
export function renderMessageTemplate(template: string, vars: Record<string, string | number>): string {
  return template
    .replace(/\{(\w+)\}/g, (_m, key: string) => (key in vars ? String(vars[key]) : ""))
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
