import { AppError, NotFoundError } from "../../core/errors";
import { confirmsOnOrder } from "../payment-settings/payment-methods";
import type { OrderReadyNotifier, OrderReadyStore, ReadyNotifyResult } from "./order-ready.types";

export class OrderReadyService {
  constructor(
    private readonly store: OrderReadyStore,
    private readonly notifier: OrderReadyNotifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async markReady(tenantId: string, orderId: string) {
    const order = await this.store.find(tenantId, orderId);
    if (!order) throw new NotFoundError("Order not found");
    if (order.status === "CANCELLED") throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled.");
    // الكاش بيتجهّز قبل ما يتدفع، إنما الدفع الأونلاين لازم يتأكد الأول
    if (order.paymentStatus === "AWAITING_PAYMENT" && !confirmsOnOrder(order.paymentMethodType)) {
      throw new AppError(409, "ORDER_NOT_PAID", "This order hasn't been paid yet.");
    }

    const claimed = await this.store.claim(tenantId, orderId, order.readyAt ?? this.now());
    if (!claimed) return this.store.load(tenantId, orderId);

    let result: ReadyNotifyResult;
    try {
      result = await this.notifier.send(order);
    } catch (err) {
      // الطلب جاهز حتى لو الرسالة فشلت - والتاجر يقدر يعيد المحاولة
      result = { state: "failed", error: err instanceof Error ? err.message : "Couldn't send the WhatsApp message" };
    }
    await this.store.saveResult(tenantId, orderId, result);
    return this.store.load(tenantId, orderId);
  }
}
