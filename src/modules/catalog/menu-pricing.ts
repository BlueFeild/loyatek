// أسعار أصناف المنيو بعد الخصم - مصدر واحد للطلب والصفحة العامة
import { applyDiscount, activeDiscountPct, priceView } from "../../utils/discount";

type PricedItem = { price: unknown; discountPct?: number | null; discountEndsAt?: Date | string | null };

// السعر اللي العميل هيدفعه فعلًا للصنف (بالدولار)
export function menuItemFinalPrice(item: PricedItem, now: Date = new Date()): number {
  return applyDiscount(Number(item.price), activeDiscountPct(item.discountPct, item.discountEndsAt, now));
}

// شكل الصنف في المنيو العام: price = السعر النهائي (عشان أي نسخة قديمة من
// الصفحة تحسب السلة صح) + originalPrice + discountPct (لو شغال بس) + finalPrice
export function publicMenuItem<T extends PricedItem>(item: T, now: Date = new Date()) {
  const view = priceView(Number(item.price), item.discountPct, item.discountEndsAt, now);
  return {
    ...item,
    price: String(view.finalPrice),
    originalPrice: view.originalPrice,
    finalPrice: view.finalPrice,
    discountPct: view.discountPct,
    discountEndsAt: view.discountPct ? item.discountEndsAt ?? null : null,
  };
}
