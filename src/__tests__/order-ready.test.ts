import { describe, expect, it, vi } from "vitest";
import { OrderReadyService } from "../modules/catalog/order-ready.service";
import { orderModeText, templateValue } from "../modules/catalog/order-whatsapp";
import type { OrderReadyNotifier, OrderReadyStore, ReadyNotifyResult, ReadyOrder } from "../modules/catalog/order-ready.types";
import { ORDER_TEMPLATES, renderTemplateBody, templateName, templateParams } from "../modules/whatsapp/booking-templates";

vi.mock("../config/db", () => ({ prisma: {} }));

function order(patch: Partial<ReadyOrder> = {}): ReadyOrder {
  return {
    id: "o1",
    tenantId: "t1",
    mode: "PICKUP",
    tableLabel: null,
    customerName: "Sara",
    customerPhone: "+97455551234",
    status: "PENDING",
    paymentStatus: "NOT_REQUIRED",
    paymentMethodType: null,
    readyAt: null,
    ...patch,
  };
}

// مخزن وهمي بنفس قاعدة الحجز الذري بتاعة الريبو
function makeStore(rows: ReadyOrder[]) {
  const saved: Record<string, ReadyNotifyResult> = {};
  const state: Record<string, string | null> = {};
  const store: OrderReadyStore = {
    find: async (tenantId, id) => rows.find((r) => r.id === id && r.tenantId === tenantId) ?? null,
    load: async (tenantId, id) => {
      const row = rows.find((r) => r.id === id && r.tenantId === tenantId);
      return row ? { ...row, readyNotify: state[id] ?? null } : null;
    },
    claim: async (tenantId, id, readyAt) => {
      const row = rows.find((r) => r.id === id && r.tenantId === tenantId);
      if (!row) return false;
      if (row.readyAt && !["failed", "not_connected"].includes(state[id] ?? "")) return false;
      row.readyAt = readyAt;
      state[id] = "sending";
      return true;
    },
    saveResult: async (_tenantId, id, result) => {
      saved[id] = result;
      state[id] = result.state;
    },
  };
  return { store, saved, state };
}

const notifier = (result: ReadyNotifyResult | Error) => {
  const send = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { send } as OrderReadyNotifier & { send: typeof send };
};

describe("OrderReadyService", () => {
  it("marks the order ready and sends the message once", async () => {
    const { store, saved } = makeStore([order()]);
    const n = notifier({ state: "template" });
    await new OrderReadyService(store, n).markReady("t1", "o1");
    await new OrderReadyService(store, n).markReady("t1", "o1");
    expect(n.send).toHaveBeenCalledTimes(1);
    expect(saved.o1.state).toBe("template");
  });

  it("does not send twice when pressed twice at the same moment", async () => {
    const { store } = makeStore([order()]);
    const n = notifier({ state: "template" });
    const service = new OrderReadyService(store, n);
    await Promise.all([service.markReady("t1", "o1"), service.markReady("t1", "o1")]);
    expect(n.send).toHaveBeenCalledTimes(1);
  });

  it("does not resend a message that went out as normal text", async () => {
    const { store } = makeStore([order()]);
    const n = notifier({ state: "text" });
    const service = new OrderReadyService(store, n);
    await service.markReady("t1", "o1");
    await service.markReady("t1", "o1");
    expect(n.send).toHaveBeenCalledTimes(1);
  });

  it("lets the merchant retry after a failure and keeps the first ready time", async () => {
    const first = new Date("2026-11-09T10:00:00Z");
    const later = new Date("2026-11-09T10:05:00Z");
    const row = order();
    const { store, state } = makeStore([row]);
    await new OrderReadyService(store, notifier({ state: "failed", error: "Meta down" }), () => first).markReady("t1", "o1");
    expect(state.o1).toBe("failed");
    const retry = notifier({ state: "template" });
    await new OrderReadyService(store, retry, () => later).markReady("t1", "o1");
    expect(retry.send).toHaveBeenCalledTimes(1);
    expect(state.o1).toBe("template");
    expect(row.readyAt).toEqual(first);
  });

  it("keeps the order ready when sending throws", async () => {
    const row = order();
    const { store, saved } = makeStore([row]);
    await new OrderReadyService(store, notifier(new Error("network"))).markReady("t1", "o1");
    expect(row.readyAt).not.toBeNull();
    expect(saved.o1).toEqual({ state: "failed", error: "network" });
  });

  it("never touches another company's order", async () => {
    const { store } = makeStore([order({ tenantId: "other" })]);
    const n = notifier({ state: "template" });
    await expect(new OrderReadyService(store, n).markReady("t1", "o1")).rejects.toMatchObject({ status: 404 });
    expect(n.send).not.toHaveBeenCalled();
  });

  it("refuses a cancelled order and an unpaid online order", async () => {
    const n = notifier({ state: "template" });
    await expect(new OrderReadyService(makeStore([order({ status: "CANCELLED" })]).store, n).markReady("t1", "o1")).rejects.toMatchObject({ code: "ORDER_CANCELLED" });
    await expect(
      new OrderReadyService(makeStore([order({ paymentStatus: "AWAITING_PAYMENT", paymentMethodType: "LINK" })]).store, n).markReady("t1", "o1")
    ).rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    expect(n.send).not.toHaveBeenCalled();
  });

  it("allows a cash order that is not collected yet", async () => {
    const { store, saved } = makeStore([order({ paymentStatus: "AWAITING_PAYMENT", paymentMethodType: "CASH" })]);
    await new OrderReadyService(store, notifier({ state: "template" })).markReady("t1", "o1");
    expect(saved.o1.state).toBe("template");
  });
});

describe("order templates", () => {
  it("meet Meta's rules: no variable first or last, numbered in order", () => {
    for (const def of Object.values(ORDER_TEMPLATES)) {
      for (const body of Object.values(def.body)) {
        expect(body.trim()).not.toMatch(/^\{\{/);
        expect(body.trim()).not.toMatch(/\}\}$/);
        const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        expect(found).toEqual(def.params.map((_p, i) => i + 1));
      }
      expect(def.example).toHaveLength(def.params.length);
    }
  });

  it("use per-language names and fill the values", () => {
    expect(templateName("ORDER_READY", "ar")).toBe("bf_order_ready_ar");
    const params = templateParams("ORDER_READY", { customer_name: "Sara", business: "Cafe", reference: "AB12", mode: "Pickup" });
    expect(renderTemplateBody("ORDER_READY", "en", params)).toContain("Hi Sara,\nYour order from Cafe is ready.");
  });

  it("keeps template values on one line, as Meta requires", () => {
    expect(templateValue("  Sara\n\tAli     K  ")).toBe("Sara Ali K");
    expect(templateValue("x".repeat(50), 10)).toHaveLength(10);
  });

  it("describes the order type in both languages", () => {
    expect(orderModeText({ mode: "PICKUP", tableLabel: null }, "ar")).toBe("استلام");
    expect(orderModeText({ mode: "DINE_IN", tableLabel: "B1" }, "en")).toBe("Table B1");
  });
});
