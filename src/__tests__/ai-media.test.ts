import { describe, expect, it } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import { CreditService } from "../modules/credits/credit.service";
import { ImageStudioService } from "../modules/ai/image-studio.service";
import { VideoStudioService } from "../modules/ai/video-studio.service";
import { AccountAuditService } from "../modules/ai/account-audit.service";
import { FakeAccountAuditor, FakeImageGenerator, FakeVideoGenerator } from "../modules/ai/fake-media-providers";
import { GeminiAccountAuditor, GeminiImageGenerator, GeminiVideoGenerator } from "../modules/ai/gemini-media-providers";
import { auditInputSchema, computeAuditMetrics, imageBriefSchema, videoBriefSchema } from "../modules/ai/media-types";
import { buildAuditPrompt, buildImagePrompt } from "../modules/ai/media.prompts";
import { makeAiProviders } from "../modules/ai/copy-generator.factory";
import { AI_COSTS } from "../modules/ai/ai-pricing";
import { InsufficientCreditsError, ServiceUnavailableError } from "../core/errors";
import { MemoryAssets, MemoryCredits, MemoryGenerations } from "./helpers/ai-memory-stores";

const biz = { name: "Doha Cafe", industry: "HOSPITALITY" };

function setup(balance: number, isPlatformOwner = false) {
  const store = new MemoryCredits({ a: { balance, isPlatformOwner }, b: { balance: 100, isPlatformOwner: false } });
  const credits = new CreditService(store);
  const assets = new MemoryAssets();
  const gens = new MemoryGenerations(assets);
  return { store, credits, assets, gens };
}

describe("ImageStudioService", () => {
  const brief = imageBriefSchema.parse({ prompt: "Spanish latte on a marble table", scene: "lusail" });
  it("generates, stores the image, charges after success; the product photo isn't stored in the log", async () => {
    const { credits, assets, gens, store } = setup(10);
    const gen = new FakeImageGenerator();
    const svc = new ImageStudioService(gen, credits, gens, assets);
    const withPhoto = imageBriefSchema.parse({ ...brief, productImage: { base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" } });
    const out = await svc.create("a", "u1", withPhoto);
    expect(out.balance).toBe(10 - AI_COSTS.image);
    expect(assets.items).toHaveLength(1);
    expect(assets.items[0]).toMatchObject({ tenantId: "a", kind: "image", mimeType: "image/png" });
    expect(gens.rows[0].input).toMatchObject({ withProductPhoto: true, scene: "lusail" });
    expect(JSON.stringify(gens.rows[0].input)).not.toContain("iVBOR");
    expect(store.log[0]).toMatchObject({ reason: "AI_IMAGE", amount: -AI_COSTS.image });
    expect((await svc.history("a"))[0].assetIds).toEqual([out.assetId]);
  });
  it("not enough credits → refused before calling the AI; failure → nothing charged", async () => {
    const { credits, assets, gens, store } = setup(2);
    const gen = new FakeImageGenerator();
    const svc = new ImageStudioService(gen, credits, gens, assets);
    await expect(svc.create("a", null, brief)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(gen.calls).toHaveLength(0);
    store.tenants.a.balance = 10;
    gen.failNext = new ServiceUnavailableError("busy");
    await expect(svc.create("a", null, brief)).rejects.toThrow("busy");
    expect(store.tenants.a.balance).toBe(10);
    expect(assets.items).toHaveLength(0);
  });
  it("not configured → 503", async () => {
    const { credits, assets, gens } = setup(10);
    await expect(new ImageStudioService(null, credits, gens, assets).create("a", null, brief)).rejects.toMatchObject({ status: 503 });
  });
});

describe("VideoStudioService (background job)", () => {
  const brief = videoBriefSchema.parse({ prompt: "Steam rising from a latte" });
  it("reserves credits, returns PENDING at once, then DONE with the video", async () => {
    const { credits, assets, gens, store } = setup(50);
    const svc = new VideoStudioService(new FakeVideoGenerator(), credits, gens, assets);
    const started = await svc.start("a", "u1", brief);
    expect(started.status).toBe("PENDING");
    expect(started.balance).toBe(50 - AI_COSTS.video);
    expect((await svc.get("a", started.id)).status).toBe("PENDING");
    await svc.whenIdle();
    const done = await svc.get("a", started.id);
    expect(done.status).toBe("DONE");
    expect(done.assetIds).toHaveLength(1);
    expect(assets.items[0]).toMatchObject({ kind: "video", mimeType: "video/mp4" });
    expect(store.tenants.a.balance).toBe(50 - AI_COSTS.video);
  });
  it("failure → FAILED with a message and the credits come back", async () => {
    const { credits, assets, gens, store } = setup(50);
    const gen = new FakeVideoGenerator();
    gen.failNext = new ServiceUnavailableError("AI video isn't set up yet");
    const svc = new VideoStudioService(gen, credits, gens, assets);
    const started = await svc.start("a", null, brief);
    await svc.whenIdle();
    const job = await svc.get("a", started.id);
    expect(job).toMatchObject({ status: "FAILED", error: "AI video isn't set up yet", creditsUsed: 0 });
    expect(store.tenants.a.balance).toBe(50);
    expect(store.log.map((l) => l.reason)).toEqual(["AI_VIDEO", "REFUND"]);
  });
  it("animates one of the company's own AI images; another company's image is refused", async () => {
    const { credits, assets, gens } = setup(50);
    const img = await assets.save({ tenantId: "a", generationId: "g0", kind: "image", mimeType: "image/png", base64: "iVBORw0KGgo=" });
    const other = await assets.save({ tenantId: "b", generationId: "g9", kind: "image", mimeType: "image/png", base64: "iVBORw0KGgo=" });
    const gen = new FakeVideoGenerator();
    const svc = new VideoStudioService(gen, credits, gens, assets);
    await svc.start("a", null, videoBriefSchema.parse({ prompt: "Make it move", sourceAssetId: img.id }));
    await svc.whenIdle();
    expect(gen.calls[0].brief.image).toMatchObject({ mimeType: "image/png" });
    await expect(svc.start("a", null, videoBriefSchema.parse({ prompt: "Make it move", sourceAssetId: other.id }))).rejects.toMatchObject({ status: 400 });
  });
  it("max 2 running per company; not enough credits → nothing left PENDING", async () => {
    const { credits, assets, gens } = setup(100);
    const gen = new FakeVideoGenerator();
    gen.delayMs = 200;
    const svc = new VideoStudioService(gen, credits, gens, assets);
    await svc.start("a", null, brief);
    await svc.start("a", null, brief);
    await expect(svc.start("a", null, brief)).rejects.toMatchObject({ status: 429 });
    await svc.whenIdle();
    const poor = setup(5);
    const svc2 = new VideoStudioService(new FakeVideoGenerator(), poor.credits, poor.gens, poor.assets);
    await expect(svc2.start("a", null, brief)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(poor.gens.rows[0].status).toBe("FAILED");
  });
  it("a job stuck PENDING (server restarted) expires and is refunded", async () => {
    const { credits, assets, gens, store } = setup(50);
    const svc = new VideoStudioService(new FakeVideoGenerator(), credits, gens, assets, 0);
    // عملية قديمة من غير ما تكون شغالة في الذاكرة
    const old = await gens.create({ tenantId: "a", tool: "video", kind: "text_to_video", input: {}, output: {}, creditsUsed: 20, model: "x", status: "PENDING" });
    gens.rows[0].createdAt = new Date(Date.now() - 60_000);
    store.tenants.a.balance = 30;
    const job = await svc.get("a", old.id);
    expect(job.status).toBe("FAILED");
    expect(store.tenants.a.balance).toBe(50);
  });
});

describe("AccountAuditService", () => {
  const input = auditInputSchema.parse({ platform: "instagram", handle: "@dohacafe", followers: 2000, avgLikes: 70, avgComments: 10, avgViews: 900 });
  it("computes the numbers itself, saves the report without screenshots, charges after success", async () => {
    const { credits, gens, store } = setup(10);
    const auditor = new FakeAccountAuditor();
    const svc = new AccountAuditService(auditor, credits, gens);
    const withShots = auditInputSchema.parse({ ...input, screenshots: [{ base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" }] });
    const out = await svc.run("a", "u1", withShots);
    expect(out.metrics).toEqual({ engagementRate: 4, viewRate: 45 });
    expect(auditor.calls[0].metrics.engagementRate).toBe(4);
    expect(out.report.healthScore).toBe(62);
    expect(gens.rows[0].input).toMatchObject({ screenshotCount: 1, handle: "@dohacafe" });
    expect(JSON.stringify(gens.rows[0].input)).not.toContain("iVBOR");
    expect(store.tenants.a.balance).toBe(10 - AI_COSTS.audit);
    expect((await svc.get("a", out.id)).output).toMatchObject({ metrics: { engagementRate: 4 } });
    await expect(svc.get("b", out.id)).rejects.toMatchObject({ status: 404 });
  });
  it("unknown numbers stay unknown (no made-up rates)", () => {
    expect(computeAuditMetrics(auditInputSchema.parse({ platform: "tiktok", handle: "x" }))).toEqual({ engagementRate: null, viewRate: null });
    expect(computeAuditMetrics(auditInputSchema.parse({ platform: "tiktok", handle: "x", followers: 0, avgLikes: 5 }))).toEqual({ engagementRate: null, viewRate: null });
  });
  it("max 4 screenshots", () => {
    const shot = { base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" };
    expect(auditInputSchema.safeParse({ platform: "x", handle: "a", screenshots: [shot, shot, shot, shot, shot] }).success).toBe(false);
  });
});

describe("prompts", () => {
  it("image prompt: business, scene, keep the product as is, Gulf rules", () => {
    const p = buildImagePrompt(imageBriefSchema.parse({ prompt: "perfume bottle", scene: "majlis", productImage: { base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" } }), biz);
    expect(p).toContain("Doha Cafe");
    expect(p).toContain("majlis");
    expect(p).toMatch(/remove its original background/);
    expect(p).toMatch(/modest clothing/);
  });
  it("audit prompt carries our calculated rate and says unknown when missing", () => {
    const i = auditInputSchema.parse({ platform: "instagram", handle: "@a", followers: 1000, avgLikes: 30 });
    const p = buildAuditPrompt(i, computeAuditMetrics(i), biz);
    expect(p).toContain("Engagement rate (calculated): 3%");
    expect(p).toContain("Average views: unknown");
  });
});

// عميل Gemini وهمي (Interactions API)
function stubInteractions(reply: unknown, seen: any[]) {
  return { interactions: { create: async (req: unknown) => (seen.push(req), reply) } } as unknown as GoogleGenAI;
}

describe("Gemini media providers (request shape)", () => {
  it("image: Nano Banana with aspect ratio, product photo attached, returns bytes", async () => {
    const seen: any[] = [];
    const gen = new GeminiImageGenerator(stubInteractions({ output_image: { data: "AAAA", mime_type: "image/png" } }, seen), "gemini-nano-banana-2.1");
    const out = await gen.generate(imageBriefSchema.parse({ prompt: "cake", aspectRatio: "4:5", productImage: { base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/jpeg" } }), biz);
    expect(out).toEqual({ base64: "AAAA", mimeType: "image/png" });
    expect(seen[0]).toMatchObject({ model: "gemini-nano-banana-2.1", store: false, response_format: { type: "image", aspect_ratio: "4:5" } });
    expect(seen[0].input[1]).toEqual({ type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mime_type: "image/jpeg" });
  });
  it("image: no image back → 422", async () => {
    const gen = new GeminiImageGenerator(stubInteractions({}, []), "m");
    await expect(gen.generate(imageBriefSchema.parse({ prompt: "cake" }), biz)).rejects.toMatchObject({ status: 422 });
  });
  it("video: Omni Flash, 9:16 720p, image first when animating", async () => {
    const seen: any[] = [];
    const gen = new GeminiVideoGenerator(stubInteractions({ output_video: { data: "BBBB", mime_type: "video/mp4" } }, seen), "gemini-omni-1.1-flash");
    const out = await gen.generate({ prompt: "steam", aspectRatio: "9:16", image: { base64: "CCCC", mimeType: "image/png" } }, biz);
    expect(out).toEqual({ base64: "BBBB", mimeType: "video/mp4" });
    expect(seen[0]).toMatchObject({ model: "gemini-omni-1.1-flash", response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p" } });
    expect(seen[0].input[0].type).toBe("image");
    expect(seen[0].system_instruction).toBeUndefined(); // Omni مابيقبلش system instruction
  });
  it("audit: JSON schema + screenshots + system rules; parses the report", async () => {
    const seen: any[] = [];
    const report = new FakeAccountAuditor();
    const json = JSON.stringify(await report.audit(auditInputSchema.parse({ platform: "x", handle: "a" }), { engagementRate: null, viewRate: null }, biz));
    const gen = new GeminiAccountAuditor(stubInteractions({ output_text: json }, seen), "gemini-flash-latest");
    const out = await gen.audit(auditInputSchema.parse({ platform: "instagram", handle: "@a", screenshots: [{ base64: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" }] }), { engagementRate: 2, viewRate: null }, biz);
    expect(out.adPlan.dailyBudgetQar).toBe(50);
    expect(seen[0].response_format).toMatchObject({ type: "text", mime_type: "application/json" });
    expect(seen[0].system_instruction).toMatch(/never invent/i);
    expect(seen[0].input).toHaveLength(2);
  });
  it("quota / billing errors become clear messages", async () => {
    const failing = (status: number, message: string) =>
      ({ interactions: { create: async () => { throw Object.assign(new Error(message), { status }); } } }) as unknown as GoogleGenAI;
    await expect(new GeminiImageGenerator(failing(429, "quota"), "m").generate(imageBriefSchema.parse({ prompt: "cake" }), biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/limit/) });
    await expect(new GeminiVideoGenerator(failing(400, "This model requires billing / paid tier"), "m").generate({ prompt: "x", aspectRatio: "9:16" }, biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/billing/) });
  });
});

describe("makeAiProviders", () => {
  it("images/video only with a Gemini key; text tools follow Claude → Gemini", () => {
    const onlyClaude = makeAiProviders({ ANTHROPIC_API_KEY: "a" });
    expect(onlyClaude.image).toBeNull();
    expect(onlyClaude.video).toBeNull();
    expect(onlyClaude.auditor?.model).toBe("claude-opus-5-5");
    const onlyGemini = makeAiProviders({ GEMINI_API_KEY: "g" });
    expect(onlyGemini.image).toBeInstanceOf(GeminiImageGenerator);
    expect(onlyGemini.auditor).toBeInstanceOf(GeminiAccountAuditor);
    const none = makeAiProviders({});
    expect([none.copy, none.image, none.video, none.auditor]).toEqual([null, null, null, null]);
  });
});

describe("Google 429: real limit vs. no free tier at all", () => {
  const failing = (message: string) =>
    ({ interactions: { create: async () => { throw Object.assign(new Error(message), { status: 429 }); } } }) as unknown as GoogleGenAI;
  it("'limit: 0' / free_tier quota → says billing is needed", async () => {
    const msg = "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-nano-banana-2.1";
    await expect(new GeminiImageGenerator(failing(msg), "m").generate(imageBriefSchema.parse({ prompt: "cake" }), biz)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/needs billing/) });
  });
  it("a normal rate limit → try again in a minute", async () => {
    await expect(new GeminiImageGenerator(failing("Resource has been exhausted (e.g. check quota)."), "m").generate(imageBriefSchema.parse({ prompt: "cake" }), biz)).rejects.toMatchObject({ message: expect.stringMatching(/try again in a minute/) });
  });
});
