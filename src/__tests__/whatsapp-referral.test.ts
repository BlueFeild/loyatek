import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "../modules/whatsapp/webhook";
import { buildAgentPrompt } from "../modules/ai/agent.prompts";

const payload = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, contacts: [{ wa_id: "974555", profile: { name: "Sara" } }], messages: [message] } }] }],
});

describe("Click-to-WhatsApp referral", () => {
  it("reads the ad the customer came from", () => {
    const [batch] = parseWebhookPayload(
      payload({ from: "974555", id: "w1", type: "text", text: { body: "Is this still available?" }, referral: { source_url: "https://fb.me/x", source_id: "1203", source_type: "ad", headline: "Eid photo session", body: "20% off this week", ctwa_clid: "abc" } })
    );
    expect(batch.messages[0].referral).toEqual({ sourceId: "1203", sourceType: "ad", headline: "Eid photo session", body: "20% off this week" });
  });
  it("normal messages have no referral", () => {
    const [batch] = parseWebhookPayload(payload({ from: "974555", id: "w2", type: "text", text: { body: "hi" } }));
    expect(batch.messages[0].referral).toBeUndefined();
  });
  it("the AI assistant is told about the ad", () => {
    const p = buildAgentPrompt({
      business: { name: "S", industry: "x", currency: "QAR", knowledge: "", menu: [], services: [], bookingHours: null, links: { booking: null, menu: null, links: null }, dialect: "auto", booking: null },
      history: [],
      message: "price?",
      customerName: null,
      ad: { headline: "Eid photo session", body: "20% off" },
    });
    expect(p).toContain('tapped your ad on Facebook/Instagram: "Eid photo session" — 20% off');
  });
});
