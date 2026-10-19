import { beforeEach, describe, expect, it, vi } from "vitest";

// شركتين وهميتين: A مشتركة في الـ ERP، B مش مشتركة (وكل الـ IDs بتاعة كل شركة)
const DAY = 86400000;
const state = {
  tenants: [] as any[],
  rows: {} as Record<string, { id: string; tenantId: string }[]>,
};

vi.mock("../config/db", () => {
  const countIn = (table: string) => async ({ where }: any) =>
    (state.rows[table] ?? []).filter((r) => r.tenantId === where.tenantId && where.id.in.includes(r.id)).length;
  return {
    prisma: {
      tenant: { findUnique: async ({ where }: any) => state.tenants.find((t) => t.id === where.id) ?? null },
      branch: { count: countIn("branch") },
      customer: { count: countIn("customer") },
      supplier: { count: countIn("supplier") },
      inventoryItem: { count: countIn("inventoryItem") },
      account: { count: countIn("account") },
      employee: { count: countIn("employee") },
      platformSettings: { findUnique: async () => null, findFirst: async () => null },
    },
  };
});
vi.mock("../utils/platform-config", () => ({ tenantGraceDays: async (t: any) => t.graceDays ?? 3 }));

import { requireModule, clearModuleAccessCache } from "../middleware/module-access";
import { assertTenantOwns } from "../utils/tenant-owned";
import { classifyBudgetCategory, isRevenueCategory, monthRange } from "../modules/budget/budget-actuals";

function runGuard(auth: any) {
  return new Promise<{ status: number; body?: any; passed: boolean }>((resolve) => {
    const res: any = {
      status(code: number) {
        return { json: (body: any) => resolve({ status: code, body, passed: false }) };
      },
    };
    requireModule("erp")({ auth } as any, res, () => resolve({ status: 200, passed: true }));
  });
}

beforeEach(() => {
  clearModuleAccessCache();
  const now = Date.now();
  state.tenants = [
    { id: "A", subscribedModules: ["erp"], moduleExpirations: {}, trialExpiresAt: null, accountStatus: "ACTIVE" },
    { id: "B", subscribedModules: ["booking"], moduleExpirations: {}, trialExpiresAt: null, accountStatus: "ACTIVE" },
    { id: "TRIAL", subscribedModules: [], moduleExpirations: {}, trialExpiresAt: new Date(now + DAY), accountStatus: "ACTIVE" },
    { id: "GRACE", subscribedModules: ["erp"], moduleExpirations: { erp: new Date(now - DAY).toISOString() }, trialExpiresAt: null, graceDays: 3 },
    { id: "EXPIRED", subscribedModules: ["erp"], moduleExpirations: { erp: new Date(now - 10 * DAY).toISOString() }, trialExpiresAt: null, graceDays: 3 },
    { id: "OWNER", subscribedModules: [], moduleExpirations: {}, trialExpiresAt: null, isPlatformOwner: true },
  ];
  state.rows = {
    branch: [{ id: "bA", tenantId: "A" }, { id: "bB", tenantId: "B" }],
    customer: [{ id: "cA", tenantId: "A" }, { id: "cB", tenantId: "B" }],
    supplier: [{ id: "sA", tenantId: "A" }, { id: "sB", tenantId: "B" }],
    inventoryItem: [{ id: "iA1", tenantId: "A" }, { id: "iA2", tenantId: "A" }, { id: "iB", tenantId: "B" }],
    account: [{ id: "aA", tenantId: "A" }, { id: "aB", tenantId: "B" }],
  };
});

describe("ERP subscription guard (backend)", () => {
  const user = (tenantId: string, extra: any = {}) => ({ userId: "u", tenantId, role: "OWNER", isSuperAdmin: false, ...extra });

  it("subscribed company passes", async () => {
    expect((await runGuard(user("A"))).passed).toBe(true);
  });
  it("company without ERP gets 403 MODULE_INACTIVE", async () => {
    const r = await runGuard(user("B"));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("MODULE_INACTIVE");
  });
  it("free trial, grace days and platform owner pass; expired after grace is blocked", async () => {
    expect((await runGuard(user("TRIAL"))).passed).toBe(true);
    expect((await runGuard(user("GRACE"))).passed).toBe(true);
    expect((await runGuard(user("OWNER"))).passed).toBe(true);
    expect((await runGuard(user("EXPIRED"))).status).toBe(403);
  });
  it("super admin / impersonation pass like the UI", async () => {
    expect((await runGuard(user("B", { isSuperAdmin: true }))).passed).toBe(true);
    expect((await runGuard(user("B", { impersonatedBy: "sa" }))).passed).toBe(true);
  });
  it("unknown tenant is blocked", async () => {
    expect((await runGuard(user("NOPE"))).status).toBe(403);
  });
});

describe("tenant ownership of referenced IDs", () => {
  it("own IDs pass (duplicates and empty values ignored)", async () => {
    await expect(
      assertTenantOwns("A", { branchIds: ["bA"], customerIds: ["cA", null], itemIds: ["iA1", "iA2", "iA1"], supplierIds: ["sA"], accountIds: ["aA"] })
    ).resolves.toBeUndefined();
  });
  it("another company's customer / branch / item / supplier / account is refused", async () => {
    await expect(assertTenantOwns("A", { customerIds: ["cB"] })).rejects.toThrow("Customer not found");
    await expect(assertTenantOwns("A", { branchIds: ["bB"] })).rejects.toThrow("Branch not found");
    await expect(assertTenantOwns("A", { itemIds: ["iA1", "iB"] })).rejects.toThrow("Inventory item not found");
    await expect(assertTenantOwns("A", { supplierIds: ["sB"] })).rejects.toThrow("Supplier not found");
    await expect(assertTenantOwns("A", { accountIds: ["aB"] })).rejects.toThrow("Account not found");
  });
  it("errors carry status 400", async () => {
    const err: any = await assertTenantOwns("A", { branchIds: ["bB"] }).catch((e) => e);
    expect(err.status).toBe(400);
  });
});

describe("budget actual source", () => {
  const accounts = [
    { id: "1", code: "4000", name: "Sales Revenue", type: "REVENUE" },
    { id: "2", code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
    { id: "3", code: "5100", name: "General Expenses", type: "EXPENSE" },
    { id: "4", code: "1000", name: "Cash", type: "ASSET" },
  ];
  it("revenue words → sales (+ revenue ledger)", () => {
    for (const c of ["Sales", "sales revenue", "Income", "مبيعات", "الإيرادات"]) {
      expect(classifyBudgetCategory(c, accounts).source).toBe("sales");
    }
    expect(isRevenueCategory("Rent")).toBe(false);
  });
  it("account name or code → that account in the ledger", () => {
    expect(classifyBudgetCategory("general expenses", accounts)).toMatchObject({ source: "account", account: { code: "5100" } });
    expect(classifyBudgetCategory("Cost of Goods Sold", accounts)).toMatchObject({ source: "account", account: { code: "5000" } });
    expect(classifyBudgetCategory("5000", accounts)).toMatchObject({ source: "account", account: { code: "5000" } });
  });
  it("asset accounts are not budget targets; anything else → bills of that category", () => {
    expect(classifyBudgetCategory("Cash", accounts).source).toBe("bills");
    expect(classifyBudgetCategory("Rent", accounts).source).toBe("bills");
    expect(classifyBudgetCategory("Marketing", accounts).source).toBe("bills");
  });
  it("month range is the whole calendar month in UTC", () => {
    const r = monthRange(12, 2026);
    expect(r.gte.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
