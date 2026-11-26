import { describe, expect, it } from "vitest";
import { buildSiteSystemPrompt, SERVICES_KB } from "../modules/site-assistant/site-assistant.knowledge";
import { FakeSiteAssistant, makeSiteAssistantModel } from "../modules/site-assistant/site-assistant.models";
import { SiteAssistantService } from "../modules/site-assistant/site-assistant.service";
import { chatRequestSchema, cleanAnswer, SERVICE_PAGES, type SiteFacts } from "../modules/site-assistant/site-assistant.types";
import { ALL_MODULES } from "../utils/modules";

const facts = (over: Partial<SiteFacts> = {}): SiteFacts => ({
  country: "QA",
  currency: "QAR",
  monthly: { booking: 142, catalog: 106, whatsapp: 288 },
  original: { booking: 142, catalog: 106, whatsapp: 360 },
  discounts: { whatsapp: { pct: 20, endsAt: "2026-12-31T00:00:00.000Z" } },
  yearlyDiscountPct: 20,
  extraCompanyPrice: 69,
  trialDays: 7,
  aiMonthlyCredits: 100,
  smsMonthlyIncluded: 200,
  ...over,
});

describe("site assistant prompt", () => {
  it("covers every sold service with a public page", () => {
    expect(SERVICES_KB.map((s) => s.id).sort()).toEqual([...ALL_MODULES].sort());
    for (const s of SERVICES_KB) expect(SERVICE_PAGES[s.id]).toBeTruthy();
  });

  it("injects the live prices, currency, discount and trial days", () => {
    const p = buildSiteSystemPrompt(facts(), "en", "pricing");
    expect(p).toContain("free trial of 7 days");
    expect(p).toContain("- Booking system: QAR 142 per month");
    expect(p).toContain("- WhatsApp CRM: QAR 288 per month (discount 20% from QAR 360, until 2026-12-31)");
    expect(p).toContain("Yearly plan: 20% cheaper");
    expect(p).toContain("QAR 69 per month");
    expect(p).toContain("on this page: pricing");
    // خدمة مالهاش سعر ← مايخترعش رقم
    expect(p).toContain("- Online Store: price not available");
  });

  it("says there is no trial when trial days are 0, and asks for Arabic on the Arabic site", () => {
    const p = buildSiteSystemPrompt(facts({ trialDays: 0, currency: "KWD", monthly: { booking: 12.5 } }), "ar");
    expect(p).toContain("no free trial");
    expect(p).not.toContain("free trial of");
    expect(p).toContain("KWD 12.500");
    expect(p).toContain("reply in simple, friendly Arabic");
  });
});

describe("site assistant validation", () => {
  it("accepts a normal chat and defaults lang to en", () => {
    const r = chatRequestSchema.safeParse({ messages: [{ role: "user", content: "hi" }] });
    expect(r.success && r.data.lang).toBe("en");
  });

  it("refuses empty, too long, wrong role and too many messages", () => {
    expect(chatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "   " }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "x".repeat(1001) }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "system", content: "hi" }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: Array.from({ length: 31 }, () => ({ role: "user", content: "a" })) }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ messages: [{ role: "user", content: "hi" }], lang: "fr" }).success).toBe(false);
  });

  it("keeps only allowed links and trims the answer", () => {
    const a = cleanAnswer({
      reply: "Hello ```json {junk",
      suggestions: ["a", "a", "b", "c", "d"],
      links: [
        { path: "https://evil.com/x", label: "x" },
        { path: "https://digital.blue-field.co/ar/pricing", label: "Prices" },
        { path: "/solutions/booking/", label: "Booking" },
        { path: "/pricing", label: "dup" },
        { path: "javascript:alert(1)", label: "bad" },
      ],
    });
    expect(a?.reply).toBe("Hello");
    expect(a?.suggestions).toEqual(["a", "b", "c"]);
    expect(a?.links).toEqual([
      { path: "/pricing", label: "Prices" },
      { path: "/solutions/booking", label: "Booking" },
    ]);
    expect(cleanAnswer({ reply: "  ", suggestions: [], links: [] })).toBeNull();
  });
});

describe("site assistant service", () => {
  const source = { facts: async () => facts() };

  it("answers from the live facts and sends only the last 12 messages", async () => {
    const model = new FakeSiteAssistant();
    const svc = new SiteAssistantService(model, source);
    const messages = Array.from({ length: 15 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const r = await svc.chat({ messages, lang: "en" }, "QA");
    expect(r.fallback).toBe(false);
    expect(r.reply).toContain("Trial 7 days. Booking QAR 142");
    const sent = model.calls[0].messages;
    expect(sent.length).toBeLessThanOrEqual(12);
    expect(sent[0].role).toBe("user");
    expect(sent[sent.length - 1].content).toBe("m14");
  });

  it("falls back (never throws) when the provider fails or is missing", async () => {
    const model = new FakeSiteAssistant();
    model.failNext = new Error("boom");
    const r = await new SiteAssistantService(model, source).chat({ messages: [{ role: "user", content: "hi" }], lang: "ar" }, null);
    expect(r.fallback).toBe(true);
    expect(r.links[0].path).toBe("/contact");
    const none = await new SiteAssistantService(null, source).chat({ messages: [{ role: "user", content: "hi" }], lang: "en" }, null);
    expect(none.fallback).toBe(true);
    expect(none.reply).toContain("support@blue-field.co");
  });

  it("picks the provider like the writer", () => {
    expect(makeSiteAssistantModel({ AI_PROVIDER: "fake" })?.model).toBe("fake");
    expect(makeSiteAssistantModel({})).toBeNull();
  });
});
