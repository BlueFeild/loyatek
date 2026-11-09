import type { PrismaClient } from "@prisma/client";
import type { OrderReadyStore, ReadyNotifyResult } from "./order-ready.types";

export class PrismaOrderReadyStore implements OrderReadyStore {
  constructor(private readonly db: PrismaClient) {}

  find(tenantId: string, orderId: string) {
    return this.db.catalogOrder.findFirst({ where: { id: orderId, tenantId } });
  }

  load(tenantId: string, orderId: string) {
    return this.db.catalogOrder.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
  }

  async claim(tenantId: string, orderId: string, readyAt: Date) {
    const { count } = await this.db.catalogOrder.updateMany({
      where: { id: orderId, tenantId, OR: [{ readyAt: null }, { readyNotify: { in: ["failed", "not_connected"] } }] },
      data: { readyAt, readyNotify: "sending", readyNotifyError: null },
    });
    return count === 1;
  }

  async saveResult(tenantId: string, orderId: string, result: ReadyNotifyResult) {
    await this.db.catalogOrder.updateMany({
      where: { id: orderId, tenantId },
      data: { readyNotify: result.state, readyNotifyError: result.state === "failed" ? result.error.slice(0, 500) : null },
    });
  }
}
