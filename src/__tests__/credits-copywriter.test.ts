import { describe, expect, it } from "vitest";
import { CreditService } from "../modules/credits/credit.service";
import { CopywriterService } from "../modules/ai/copywriter.service";
import { FakeCopyGenerator } from "../modules/ai/fake-copy-generator";
import { MemoryCredits, MemoryGenerations } from "./helpers/ai-memory-stores";
import { copyBriefSchema } from "../modules/ai/copy-generator";
import { buildCopyPrompt } from "../modules/ai/copywriter.prompts";
import { InsufficientCreditsError, ServiceUnavailableError } from "../core/errors";

const brief = copyBriefSchema.parse({ kind: "caption", topic: "قهوة جديدة" });

function setup(tenants: Record<string, { balance: number; isPlatformOwner: boolean }>) {
  const store = new MemoryCredits(tenants);
  const credits = new CreditService(store);
  const gen = new FakeCopyGenerator();
  const gens = new MemoryGenerations();
  return { store, credits, gen, gens, writer: new CopywriterService(gen, credits, gens) };
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
});

describe("CopywriterService", () => {
  it("writes, saves and charges 1 credit after success", async () => {
    const { writer, gens, store } = setup({ a: { balance: 2, isPlatformOwner: false } });
    const out = await writer.write("a", "u1", brief);
    expect(out.variants).toHaveLength(3);
    expect(out.balance).toBe(1);
    expect(gens.rows[0]).toMatchObject({ tenantId: "a", tool: "copywriter", kind: "caption", creditsUsed: 1, model: "fake" });
    expect(store.log[0]).toMatchObject({ reason: "AI_COPY", refId: "gen1", amount: -1 });
  });
  it("no credits → refused before calling the AI", async () => {
    const { writer, gen } = setup({ a: { balance: 0, isPlatformOwner: false } });
    await expect(writer.write("a", null, brief)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(gen.calls).toHaveLength(0);
  });
  it("AI failure → nothing charged, nothing saved", async () => {
    const { writer, gen, gens, store } = setup({ a: { balance: 2, isPlatformOwner: false } });
    gen.failNext = new ServiceUnavailableError("busy");
    await expect(writer.write("a", null, brief)).rejects.toThrow("busy");
    expect(store.tenants.a.balance).toBe(2);
    expect(gens.rows).toHaveLength(0);
  });
  it("not configured → clear 503", async () => {
    const { credits, gens } = setup({ a: { balance: 2, isPlatformOwner: false } });
    await expect(new CopywriterService(null, credits, gens).write("a", null, brief)).rejects.toMatchObject({ status: 503 });
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
