// رد "حالة الدفع" العام (العميل راجع من صفحة الدفع برقم الطلب في الرابط) - تدقيق COM-09:
// بيرجّع اللي صفحة التأكيد محتاجاه بس، من غير تليفون/إيميل/ملاحظات العميل وأرقام وروابط البوابة.
// أي حد معاه الرابط (مثلًا اتبعت لحد تاني) مايشوفش بيانات شخصية
const PRIVATE_FIELDS = [
  "tenantId",
  "customerPhone",
  "customerEmail",
  "note",
  "answers",
  "myFatoorahInvoiceId",
  "myFatoorahPaymentId",
  "myFatoorahPaymentUrl",
  "holdTokenHash",
  "promoCodeId",
  "reminderSentAt",
  "readyNotifyError",
] as const;

export function payerView<T extends Record<string, unknown>>(row: T): Omit<T, (typeof PRIVATE_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...row };
  for (const f of PRIVATE_FIELDS) delete out[f];
  // المورد (الأخصائي/المكان) اسمه بس
  const resource = out.resource as { id?: string; name?: string } | undefined;
  if (resource && typeof resource === "object") out.resource = { id: resource.id, name: resource.name };
  return out as Omit<T, (typeof PRIVATE_FIELDS)[number]>;
}
