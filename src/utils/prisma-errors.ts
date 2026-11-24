// خطأ "القيمة دي موجودة قبل كده" من Prisma (unique index) - بيتحوّل لرد مفهوم بدل 500
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

// updateMany بيرجّع count = 0 بدل ما يرمي لو قيمة unique اتكررت (زي رقم دفعة استُخدم قبل كده)
export function zeroOnUniqueClash<T extends { count: number }>(p: Promise<T>): Promise<T | { count: 0 }> {
  return p.catch((err) => {
    if (isUniqueViolation(err)) return { count: 0 as const };
    throw err;
  });
}

// رد مفهوم لأخطاء Prisma المتوقعة بدل 500 (تدقيق ERP-14): قيمة مكررة (زي SKU موجود)، حاجة مش موجودة،
// ربط بحاجة مش موجودة، أو قيمة مش صالحة (زي تاريخ غلط)
export function prismaErrorResponse(err: unknown): { status: number; body: { error: string; code: string } } | null {
  const e = err as { code?: string; name?: string } | null;
  if (!e) return null;
  if (e.code === "P2002") return { status: 409, body: { error: "This already exists — use a different value (for example another code or SKU)", code: "ALREADY_EXISTS" } };
  if (e.code === "P2025") return { status: 404, body: { error: "We couldn't find this item — it may have been deleted", code: "NOT_FOUND" } };
  if (e.code === "P2003") return { status: 400, body: { error: "This refers to something that doesn't exist", code: "INVALID_REFERENCE" } };
  if (e.code === "P2000" || e.code === "P2006" || e.code === "P2007" || e.code === "P2020" || e.name === "PrismaClientValidationError") {
    return { status: 400, body: { error: "Some of the values are not valid — please check them and try again", code: "INVALID_VALUE" } };
  }
  return null;
}
