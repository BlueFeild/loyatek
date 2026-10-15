// أرقام التليفون الجديدة بتيجي بالكود ("+97455551234")، والقديمة ممكن تكون
// متخزنة من غير كود ("55551234") أو بمسافات. البحث بالرقم بيلاقي الاتنين:
// نفس الرقم بالظبط، أو أي رقم آخره نفس آخر 8 أرقام
export function phoneMatch(phone: string) {
  const exact = phone.trim();
  const digits = exact.replace(/\D/g, "");
  if (digits.length < 8) return { customerPhone: exact };
  return { OR: [{ customerPhone: exact }, { customerPhone: { endsWith: digits.slice(-8) } }] };
}
