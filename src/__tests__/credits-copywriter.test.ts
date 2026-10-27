import { describe, expect, it } from "vitest";
import { CreditService } from "../modules/credits/credit.service";
import { CopywriterService } from "../modules/ai/copywriter.service";
import { FakeCopyGenerator } from "../modules/ai/fake-copy-generator";
import { MemoryCredits, MemoryGenerations, MemoryProfiles } from "./helpers/ai-memory-stores";
import { copyBriefSchema } from "../modules/ai/copy-generator";
import { buildCopyPrompt } from "../modules/ai/copywriter.prompts";
import { InsufficientCreditsError, ServiceUnavailableError } from "../core/errors";

const brief = copyBriefSchema.parse({ kind: "caption", topic: "قهوة جديدة" });

function setup(tenants: Record<string, { balance: number; isPlatformOwner: boolean }>) {
  const store = new MemoryCredits(tenants);
  const credits = new CreditService(store);
  const gen = new FakeCopyGenerator();
  const gens = new MemoryGenerations();
  return { store, credits, gen, gens, writer: new CopywriterService(gen, credits, gens, new MemoryProfiles()) };
}

describe("CreditService", () => {
  it("grants, spends and never goes below zero", async () => {
    const { credits, store } = setup({ a: { balance: 0, isPlatformOwner: false } });
    expect(await credits.grant("a", 5, "admin")).toBe(5);
    expect(await credits.spend({ tenantId: "a", cost: 3, reason: "AI_COPY" })).toBe(2);
    await expect(credits.spend({ tenantId: "a", cost: 3, reason: "AI_COPY" })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(store.tenants.a.balance).toBe(2);
    await expect(credits.grant("a", -5, "admin")).rejects.toThrow(/doesn't have that many/);
    await expect(credits.grant("a", 0, "admin")).rejects.toThrow();
  });
  it("platform owner is never charged but usage is logged", async () => {
    const { credits, store } = setup({ p: { balance: 0, isPlatformOwner: true } });
    expect(await credits.spend({ tenantId: "p", cost: 4, reason: "AI_COPY" })).toBe(0);
    expect(store.log).toHaveLength(1);
    expect(store.log[0].amount).toBe(-4);
  });
  it("chargeFor: pays first, refunds and rethrows when the work fails", async () => {
    const { credits, store } = setup({ a: { balance: 3, isPlatformOwner: false } });
    const ok = await credits.chargeFor({ tenantId: "a", cost: 2, reason: "AI_COPY", refId: "r1" }, async () => {
      expect(store.tenants.a.balance).toBe(1); // اتخصم قبل الشغل
      return "done";
    });
    expect(ok).toEqual({ result: "done", balance: 1 });
    await expect(credits.chargeFor({ tenantId: "a", cost: 1, reason: "AI_COPY", refId: "r2" }, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(store.tenants.a.balance).toBe(1);
    expect(store.log.map((l) => [l.reason, l.amount, l.refId])).toEqual([
      ["AI_COPY", -2, "r1"],
      ["AI_COPY", -1, "r2"],
      ["REFUND", 1, "r2"],
    ]);
    let ran = false;
    await expect(credits.chargeFor({ tenantId: "a", cost: 5, reason: "AI_COPY" }, async () => void (ran = true))).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(ran).toBe(false);
  });
  it("system grants have no user and a clear reason", async () => {
    const { credits, store } = setup({ a: { balance: 0, isPlatformOwner: false } });
    await credits.grant("a", 7, null, "Free trial credits", "TRIAL");
    expect(store.log[0]).toMatchObject({ reason: "TRIAL", createdById: null, amount: 7 });
  });
});

describe("CopywriterService", () => {
  it("charges 1 credit, writes and saves", async () => {
    const { writer, gens, store } = setup({ a: { balance: 2, isPlatformOwner: false } });
    const out = await writer.write("a", "u1", brief);
    expect(out.variants).toHaveLength(3);
    expect(out.balance).toBe(1);
    expect(gens.rows[0]).toMatchObject({ id: out.id, tenantId: "a", tool: "copywriter", kind: "caption", creditsUsed: 1, model: "fake" });
    expect(store.log[0]).toMatchObject({ reason: "AI_COPY", refId: out.id, amount: -1 });
  });
  it("10 requests at once with 3 credits → exactly 3 results, never a free one", async () => {
    const { writer, gen, gens, store } = setup({ a: { balance: 3, isPlatformOwner: false } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => writer.write("a", null, brief)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientCreditsError)).toBe(true);
    expect(gen.calls).toHaveLength(3);
    expect(gens.rows).toHaveLength(3);
    expect(store.tenants.a.balance).toBe(0);
  });
  it("no credits → refused before calling the AI", async () => {
    const { writer, gen } = setup({ a: { balance: 0, isPlatformOwner: false } });
    await expect(writer.write("a", null, brief)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(gen.calls).toHaveLength(0);
  });
  it("AI failure → refunded, nothing saved", async () => {
    const { writer, gen, gens, store } = setup({ a: { balance: 2, isPlatformOwner: false } });
    gen.failNext = new ServiceUnavailableError("busy");
    await expect(writer.write("a", null, brief)).rejects.toThrow("busy");
    expect(store.tenants.a.balance).toBe(2);
    expect(store.log.map((l) => l.reason)).toEqual(["AI_COPY", "REFUND"]);
    expect(gens.rows).toHaveLength(0);
  });
  it("not configured → clear 503", async () => {
    const { credits, gens } = setup({ a: { balance: 2, isPlatformOwner: false } });
    await expect(new CopywriterService(null, credits, gens, new MemoryProfiles()).write("a", null, brief)).rejects.toMatchObject({ status: 503 });
  });
});

describe("brief + prompt", () => {
  it("defaults to Qatari dialect, 3 variants; validates topic", () => {
    expect(brief).toMatchObject({ dialect: "qatari", variants: 3, tone: "friendly" });
    expect(copyBriefSchema.safeParse({ kind: "caption", topic: "x" }).success).toBe(false);
    expect(copyBriefSchema.safeParse({ kind: "poem", topic: "hello" }).success).toBe(false);
  });
  it("prompt carries business, kind rules and facts; platform only where it matters", () => {
    const p = buildCopyPrompt(copyBriefSchema.parse({ kind: "sms", topic: "عرض", details: "خصم 20%" }), { name: "Doha Cafe", industry: "RESTAURANT" });
    expect(p).toContain("Doha Cafe");
    expect(p).toContain("70 characters");
    expect(p).toContain("خصم 20%");
    expect(p).not.toContain("Platform:");
  });
});
