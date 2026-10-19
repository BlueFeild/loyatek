import { beforeEach, describe, expect, it, vi } from "vitest";

// شركتين وهميتين A و B - كل صف تبع شركة. الهدف: أي ID من شركة تانية يترفض
// قبل ما يتكتب أي حاجة في قاعدة البيانات
const state = {
  rows: {} as Record<string, { id: string; tenantId: string }[]>,
  writes: [] as string[],
};

vi.mock("../config/db", () => {
  const countIn = (table: string) => async ({ where }: any) =>
    (state.rows[table] ?? []).filter((r) => r.tenantId === where.tenantId && where.id.in.includes(r.id)).length;
  const write = (name: string) => async () => {
    state.writes.push(name);
    return { id: "new" };
  };
  return {
    prisma: {
      branch: { count: countIn("branch") },
      customer: { count: countIn("customer") },
      supplier: { count: countIn("supplier") },
      inventoryItem: { count: countIn("inventoryItem"), findFirst: async () => null, update: write("inventoryItem.update") },
      account: { count: countIn("account") },
      employee: { count: countIn("employee"), findFirst: async () => null },
      resource: { count: countIn("resource") },
      user: { count: countIn("user") },
      whatsappTemplate: { count: countIn("whatsappTemplate") },
      booking: { create: write("booking.create") },
      catalogOrder: { create: write("catalogOrder.create") },
      menuItem: { findMany: async () => [] },
      sale: { create: write("sale.create") },
      $transaction: write("$transaction"),
    },
  };
});

import { assertTenantOwns } from "../utils/tenant-owned";
import { recordSale } from "../modules/hr/sales.service";
import { createBooking } from "../modules/booking/bookings.service";
import { createOrder } from "../modules/catalog/catalog.service";

beforeEach(() => {
  state.writes = [];
  state.rows = {
    branch: [{ id: "bA", tenantId: "A" }, { id: "bB", tenantId: "B" }],
    customer: [{ id: "cA", tenantId: "A" }, { id: "cB", tenantId: "B" }],
    employee: [{ id: "eA", tenantId: "A" }, { id: "eB", tenantId: "B" }],
    resource: [{ id: "rA", tenantId: "A" }, { id: "rB", tenantId: "B" }],
    user: [{ id: "uA", tenantId: "A" }, { id: "uB", tenantId: "B" }],
    whatsappTemplate: [{ id: "tA", tenantId: "A" }, { id: "tB", tenantId: "B" }],
  };
});

describe("assertTenantOwns — new tables", () => {
  it("accepts own resource / user / template / employee (assignee)", async () => {
    await expect(
      assertTenantOwns("A", { resourceIds: ["rA"], userIds: ["uA"], whatsappTemplateIds: ["tA"], employeeIds: ["eA"] })
    ).resolves.toBeUndefined();
  });
  it("refuses another company's resource / user / template / employee", async () => {
    await expect(assertTenantOwns("A", { resourceIds: ["rB"] })).rejects.toThrow("Resource not found");
    await expect(assertTenantOwns("A", { userIds: ["uB"] })).rejects.toThrow("User not found");
    await expect(assertTenantOwns("A", { whatsappTemplateIds: ["tB"] })).rejects.toThrow("Template not found");
    await expect(assertTenantOwns("A", { employeeIds: ["eB"] })).rejects.toThrow("Employee not found");
  });
  it("null / undefined optional IDs are skipped (e.g. no assignee, no template)", async () => {
    await expect(assertTenantOwns("A", { employeeIds: [null], whatsappTemplateIds: [undefined], customerIds: [undefined] })).resolves.toBeUndefined();
  });
  it("NotOwnedError carries status 400", async () => {
    const err: any = await assertTenantOwns("A", { branchIds: ["bB"] }).catch((e) => e);
    expect(err.status).toBe(400);
  });
});

describe("services refuse foreign IDs before writing", () => {
  it("recordSale: foreign branch or customer → refused, nothing written", async () => {
    await expect(recordSale({ tenantId: "A", branchId: "bB", employeeId: "eA", itemId: "i", quantity: 1 })).rejects.toThrow("Branch not found");
    await expect(
      recordSale({ tenantId: "A", branchId: "bA", employeeId: "eA", itemId: "i", quantity: 1, customerId: "cB" })
    ).rejects.toThrow("Customer not found");
    expect(state.writes).toEqual([]);
  });
  it("createBooking (dashboard + public page): another company's resource or branch → refused", async () => {
    const base = { tenantId: "A", customerName: "Ali", customerPhone: "+97455551234", date: "2030-01-01", hour: 10 };
    await expect(createBooking({ ...base, branchId: "bA", resourceId: "rB" })).rejects.toThrow("Resource not found");
    await expect(createBooking({ ...base, branchId: "bB", resourceId: "rA" })).rejects.toThrow("Branch not found");
    expect(state.writes).toEqual([]);
  });
  it("createOrder: another company's branch → refused", async () => {
    await expect(
      createOrder({
        tenantId: "A",
        branchId: "bB",
        mode: "PICKUP",
        customerName: "Ali",
        customerPhone: "+97455551234",
        items: [{ menuItemId: "m1", quantity: 1 }],
      } as any)
    ).rejects.toThrow("Branch not found");
    expect(state.writes).toEqual([]);
  });
});
