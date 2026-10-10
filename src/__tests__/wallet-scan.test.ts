import { describe, it, expect, vi, beforeEach } from "vitest";

// داتابيز وهمية في الذاكرة بتحاكي بس الاستعلامات اللي خدمة الـ scan
// بتستخدمها - بنختبر منطق الختم/الهدية/العزل بين الشركات، مش الـ SQL نفسه
const state = vi.hoisted(() => ({
  customers: [] as any[],
  settings: [] as any[],
  events: [] as any[],
  rewards: [] as any[],
  seq: 0,
}));

vi.mock("../config/db", () => {
  const match = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? true : row[k] === v));
  const db: any = {
    walletCustomer: {
      findFirst: async ({ where }: any) => state.customers.find((c) => match(c, where)) ?? null,
      findUnique: async ({ where }: any) => state.customers.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(state.customers.find((c) => c.id === where.id), data),
    },
    walletSettings: {
      findUnique: async ({ where }: any) => state.settings.find((s) => s.tenantId === where.tenantId) ?? null,
      create: async ({ data }: any) => {
        const row = { engine: "stamp", stampCount: 5, rewardText: "Free reward", ...data };
        state.settings.push(row);
        return row;
      },
    },
    walletEvent: {
      create: async ({ data }: any) => {
        const row = { id: `e${++state.seq}`, createdAt: new Date(), ...data };
        state.events.push(row);
        return row;
      },
    },
    walletReward: {
      create: async ({ data }: any) => {
        const row = { id: `r${++state.seq}`, status: "AVAILABLE", createdAt: new Date(state.seq), ...data };
        state.rewards.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.rewards.filter((r) => match(r, where)),
      findFirst: async ({ where }: any) => state.rewards.find((r) => match(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const rows = state.rewards.filter((r) => match(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    user: { findUnique: async ({ where }: any) => ({ name: where.id === "u1" ? "Ahmed" : "Sara" }) },
    $queryRaw: async () => [],
  };
  db.$transaction = async (fn: any) => fn(db);
  return { prisma: db };
});

import { addStampByCode, redeemRewardByCode, scanByCode, WalletFlowError } from "../modules/wallet/wallet-scan.service";

const actor = { userId: "u1", name: "Ahmed" };

beforeEach(() => {
  state.customers = [
    { id: "c1", tenantId: "t1", name: "Mona", phone: "+201", balance: 0, tier: "SILVER", lastVisitAt: null, memberCode: "CODE-MONA-0000001" },
    { id: "c2", tenantId: "t2", name: "Other cafe", phone: "+202", balance: 0, tier: "SILVER", lastVisitAt: null, memberCode: "CODE-OTHER-000001" },
  ];
  state.settings = [{ tenantId: "t1", engine: "stamp", stampCount: 5, rewardText: "Free coffee" }];
  state.events = [];
  state.rewards = [];
  state.seq = 0;
});

describe("scan / stamp / redeem", () => {
  it("scan only looks up - it changes nothing", async () => {
    const res = await scanByCode("t1", "CODE-MONA-0000001");
    expect(res.customer.name).toBe("Mona");
    expect((res.customer as any).memberCode).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.customers[0].balance).toBe(0);
  });

  it("a code from another company is treated as unknown (tenant isolation)", async () => {
    await expect(scanByCode("t1", "CODE-OTHER-000001")).rejects.toMatchObject({ status: 404 });
    await expect(addStampByCode("t1", "CODE-OTHER-000001", actor)).rejects.toBeInstanceOf(WalletFlowError);
    expect(state.customers[1].balance).toBe(0);
    expect(state.events).toHaveLength(0);
  });

  it("5 stamps unlock exactly one gift, and every stamp is logged with the staff name", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await addStampByCode("t1", "CODE-MONA-0000001", actor);
      expect(r.rewardsEarned).toBe(0);
      expect(r.customer.balance).toBe(i);
      expect(r.availableRewards).toHaveLength(0);
    }
    const fifth = await addStampByCode("t1", "CODE-MONA-0000001", actor);
    expect(fifth.rewardsEarned).toBe(1);
    expect(fifth.customer.balance).toBe(0);
    expect(fifth.availableRewards).toHaveLength(1);
    expect(fifth.availableRewards[0].label).toBe("Free coffee");

    expect(state.events.filter((e) => e.type === "STAMP")).toHaveLength(5);
    expect(state.events.filter((e) => e.type === "REWARD_EARNED")).toHaveLength(1);
    expect(state.events.every((e) => e.actorName === "Ahmed" && e.tenantId === "t1")).toBe(true);
  });

  it("redeeming hands over the gift once, then refuses", async () => {
    for (let i = 0; i < 5; i++) await addStampByCode("t1", "CODE-MONA-0000001", actor);

    const done = await redeemRewardByCode("t1", "CODE-MONA-0000001", { userId: "u2", name: "Sara" });
    expect(done.redeemedLabel).toBe("Free coffee");
    expect(done.availableRewards).toHaveLength(0);
    expect(state.rewards[0].status).toBe("REDEEMED");
    expect(state.rewards[0].redeemedByName).toBe("Sara");
    expect(state.events.at(-1)).toMatchObject({ type: "REWARD_REDEEMED", actorName: "Sara" });

    await expect(redeemRewardByCode("t1", "CODE-MONA-0000001", actor)).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to redeem when no gift was earned", async () => {
    await expect(redeemRewardByCode("t1", "CODE-MONA-0000001", actor)).rejects.toThrow(/no gift/i);
  });

  it("only works for the stamp loyalty type", async () => {
    state.settings[0].engine = "points";
    await expect(addStampByCode("t1", "CODE-MONA-0000001", actor)).rejects.toThrow(/Stamp/);
    expect(state.events).toHaveLength(0);
  });
});
