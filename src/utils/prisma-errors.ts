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
