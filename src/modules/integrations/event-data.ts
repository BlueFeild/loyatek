// اللي بيتبعت في الـ webhook لكل حدث: بيانات واضحة بس (من غير لينكات دفع داخلية أو أرقام فواتير)
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

export function bookingEventData(b: any) {
  return {
    id: b.id,
    status: b.status,
    date: iso(b.date)?.slice(0, 10) ?? null,
    hour: b.hour,
    services: b.services ?? [],
    customer: { name: b.customerName, phone: b.customerPhone, email: b.customerEmail ?? null },
    branchId: b.branchId,
    resourceId: b.resourceId,
    paymentStatus: b.paymentStatus,
    paymentMethod: b.paymentMethodLabel ?? b.paymentMethodType ?? null,
    // بالدولار (زي كل الفلوس المتخزنة)
    amountUsd: num(b.amount),
    note: b.note ?? null,
    createdAt: iso(b.createdAt),
  };
}

export function orderEventData(o: any) {
  return {
    id: o.id,
    status: o.status,
    mode: o.mode,
    table: o.tableLabel ?? null,
    customer: { name: o.customerName ?? null, phone: o.customerPhone ?? null },
    branchId: o.branchId,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethodLabel ?? o.paymentMethodType ?? null,
    totalUsd: num(o.totalAmount),
    items: Array.isArray(o.items) ? o.items.map((i: any) => ({ name: i.name ?? null, quantity: i.quantity ?? null, unitPriceUsd: num(i.unitPrice ?? i.price) })) : [],
    createdAt: iso(o.createdAt),
  };
}
