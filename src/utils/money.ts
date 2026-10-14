// عملة المنيو (CatalogSettings.currency) - نفس اللستة اللي في الفرونت إند
// (frontend/src/lib/money.ts). بنقبل بس العملات دي عشان العرض يفضل مضبوط
export const MENU_CURRENCY_CODES = ["QAR", "EGP", "AED", "SAR", "KWD", "BHD", "OMR", "JOD", "USD", "EUR", "GBP"] as const;

// 25 + "QAR" -> "QAR 25.00" (للرسايل والإشعارات)
export function formatMoney(amount: number | string, currency: string | null | undefined = "USD"): string {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(value)
      .replace(/\u00a0/g, " "); // مسافة عادية (Intl بيحط non-breaking space)
  } catch {
    return `${currency ?? ""} ${value.toFixed(2)}`.trim();
  }
}
