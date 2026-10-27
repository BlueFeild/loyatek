import { beforeEach, describe, expect, it, vi } from "vitest";

// قاعدة بيانات وهمية فيها transactions حقيقية (لو حاجة رمت خطأ كل التغييرات بترجع)
const { db, client, txLock } = vi.hoisted(() => {
const db = {
  orders: new Map<string, any>(),
  tenants: new Map<string, any>(),
  credits: [] as any[],
  failCreditFor: null as string | null,
};
const tick = () => new Promise((r) => setImmediate(r));
const txLock = { current: Promise.resolve() as Promise<void> };

const client = {
  subscriptionOrder: {
    findUnique: async ({ where }: any) => {
      const o = db.orders.get(where.id);
      return o ? { ...o, tenant: { ...db.tenants.get(o.tenantId), users: [] } } : null;
    },
    updateMany: async ({ where, data }: any) => {
      await tick();
      const o = db.orders.get(where.id);
      if (!o || !where.status.in.includes(o.status)) return { count: 0 };
      Object.assign(o, data);
      return { count: 1 };
    },
  },
  tenant: {
    update: async ({ where, data }: any) => Object.assign(db.tenants.get(where.id), data),
  },
};

  return { db, client, txLock };
});

vi.mock("../config/db", () => ({
  prisma: {
    ...client,
    // transactions ورا بعض (زي قفل الصف في Postgres) + رجوع كامل لو حصل خطأ
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const run = txLock.current.then(async () => {
        const snapshot = structuredClone({ orders: [...db.orders], tenants: [...db.tenants], credits: db.credits });
        try {
          return await fn(client);
        } catch (err) {
          db.orders = new Map(snapshot.orders);
          db.tenants = new Map(snapshot.tenants);
          db.credits = snapshot.credits;
          throw err;
        }
      });
      txLock.current = run.then(() => undefined, () => undefined);
      return run;
    },
  },
}));
vi.mock("../core/container", () => ({
  container: {
    creditLedger: {
      apply: async (m: any, tx: any) => {
        if (!tx) throw new Error("must run inside the activation transaction");
        if (db.failCreditFor === m.tenantId) return null;
        const t = db.tenants.get(m.tenantId);
        t.creditBalance += m.amount;
        db.credits.push(m);
        return t.creditBalance;
      },
    },
  },
}));
vi.mock("../utils/platform-config", () => ({ getPlatformConfig: async () => ({ aiMonthlyCredits: 100, aiYearlyCredits: 1500 }) }));
vi.mock("../modules/notifications/notifications.service", () => ({ createNotification: async () => null }));
vi.mock("../modules/checkout/myfatoorah", () => ({ checkPlatformInvoice: async () => ({}) }));
vi.mock("../modules/tenants/company-creation.service", () => ({ createLinkedCompany: async () => ({ id: "new", name: "New" }) }));

import { activateSubscriptionOrder } from "../modules/checkout/order-activation";

beforeEach(() => {
  db.tenants = new Map([["t1", { id: "t1", subscribedModules: [], moduleExpirations: {}, creditBalance: 5 }]]);
  db.orders = new Map([["o1", { id: "o1", tenantId: "t1", status: "PAID", orderType: "MODULES", selectedModules: ["ai"], billingCycle: "monthly" }]]);
  db.credits = [];
  db.failCreditFor = null;
});

describe("AI subscription credits on activation", () => {
  it("activating twice at the same moment adds the credits once (inside the activation transaction)", async () => {
    const [a, b] = await Promise.all([activateSubscriptionOrder("o1"), activateSubscriptionOrder("o1")]);
    expect([a, b].filter((r: any) => r.alreadyActive)).toHaveLength(1);
    expect(db.tenants.get("t1").creditBalance).toBe(105);
    expect(db.credits).toEqual([expect.objectContaining({ reason: "AI_SUBSCRIPTION", refId: "o1", createdById: null, amount: 100 })]);
    expect(db.orders.get("o1").status).toBe("ACTIVATED");
    expect(db.tenants.get("t1").subscribedModules).toEqual(["ai"]);
  });
  it("if the credits can't be added, nothing is activated (retried later)", async () => {
    db.failCreditFor = "t1";
    await expect(activateSubscriptionOrder("o1")).rejects.toThrow();
    expect(db.orders.get("o1").status).toBe("PAID");
    expect(db.tenants.get("t1").subscribedModules).toEqual([]);
    db.failCreditFor = null;
    await activateSubscriptionOrder("o1");
    expect(db.tenants.get("t1").creditBalance).toBe(105);
  });
  it("orders without AI add no credits", async () => {
    db.orders.get("o1").selectedModules = ["booking"];
    await activateSubscriptionOrder("o1");
    expect(db.credits).toHaveLength(0);
  });
});
