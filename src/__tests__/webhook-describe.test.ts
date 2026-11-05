import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
vi.mock("../core/container", () => ({ container: {} }));

import { describeWebhook } from "../modules/whatsapp/webhook";

describe("describeWebhook (log line, no message content)", () => {
  it("summarizes fields, waba, phone id and counts without text or customer numbers", () => {
    const line = describeWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "P1" }, messages: [{ from: "97455551234", id: "m", type: "text", text: { body: "secret hello" } }] } }] }],
    });
    expect(line).toBe("object=whatsapp_business_account field=messages waba=WABA1 phone_id=P1 messages=1 statuses=0 echoes=0");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("97455551234");
  });
  it("handles events without metadata / empty bodies", () => {
    expect(describeWebhook({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "account_update", value: {} }] }] })).toContain("field=account_update waba=W phone_id=none");
    expect(describeWebhook(undefined)).toBe("empty body");
  });
});
