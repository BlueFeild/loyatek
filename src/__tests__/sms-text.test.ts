import { describe, expect, it } from "vitest";
import { countSegments, maskPhone, normalizePhone, parsePastedList, renderSmsBody, SENDER_NAME_RE } from "../modules/sms/sms-text";
import { providerFromEnv } from "../modules/sms/sms-provider";
import { includedSms } from "../modules/sms/sms-subscription";

describe("countSegments", () => {
  it("plain English: exactly 160 = 1 SMS, 161 = 2", () => {
    expect(countSegments("a".repeat(160))).toEqual({ encoding: "GSM-7", chars: 160, segments: 1, remainingInPart: 0 });
    const r = countSegments("a".repeat(161));
    expect(r.segments).toBe(2);
    expect(r.remainingInPart).toBe(306 - 161);
    expect(countSegments("a".repeat(306)).segments).toBe(2);
    expect(countSegments("a".repeat(307)).segments).toBe(3);
  });
  it("extended GSM characters count 2", () => {
    const r = countSegments("€".repeat(80));
    expect(r.encoding).toBe("GSM-7");
    expect(r.chars).toBe(160);
    expect(r.segments).toBe(1);
    expect(countSegments("{" + "a".repeat(159)).segments).toBe(2);
  });
  it("Arabic uses UCS-2: 70 / 67", () => {
    expect(countSegments("م".repeat(70))).toEqual({ encoding: "UCS-2", chars: 70, segments: 1, remainingInPart: 0 });
    expect(countSegments("م".repeat(71)).segments).toBe(2);
    expect(countSegments("م".repeat(134)).segments).toBe(2);
    expect(countSegments("م".repeat(135)).segments).toBe(3);
    expect(countSegments("Hello مرحبا").encoding).toBe("UCS-2");
  });
  it("emoji counts as 2 UTF-16 units and switches to UCS-2", () => {
    const r = countSegments("Hi 😀");
    expect(r.encoding).toBe("UCS-2");
    expect(r.chars).toBe(5);
    expect(countSegments("😀".repeat(35)).segments).toBe(1);
    expect(countSegments("😀".repeat(36)).segments).toBe(2);
  });
  it("empty text = 0 SMS", () => {
    expect(countSegments("").segments).toBe(0);
  });
});

describe("phones", () => {
  it("normalizes to digits with country code", () => {
    expect(normalizePhone("+974 5555 1234")).toBe("97455551234");
    expect(normalizePhone("0097455551234")).toBe("97455551234");
    expect(normalizePhone("(974) 5555-1234")).toBe("97455551234");
    expect(normalizePhone("55551234")).toBeNull(); // من غير كود الدولة
    expect(normalizePhone("+97455abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("1234567890123456")).toBeNull();
  });
  it("masks the middle digits", () => {
    expect(maskPhone("97455551234")).toBe("9745***1234");
  });
});

describe("parsePastedList", () => {
  it("reads phone[,name] lines, drops duplicates and reports bad lines", () => {
    const r = parsePastedList("+97455551234, Sara\n\n97455551234\n0097466667777;Omar Ali\nhello\n55551234\n+201001234567\tمنى");
    expect(r.recipients).toEqual([
      { phone: "97455551234", name: "Sara" },
      { phone: "97466667777", name: "Omar Ali" },
      { phone: "201001234567", name: "منى" },
    ]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid.map((i) => i.line)).toEqual([5, 6]);
    expect(r.tooMany).toBe(false);
  });
  it("stops at the maximum", () => {
    const text = Array.from({ length: 12 }, (_, i) => `+9745555${String(1000 + i)}`).join("\n");
    const r = parsePastedList(text, 10);
    expect(r.recipients).toHaveLength(10);
    expect(r.tooMany).toBe(true);
  });
});

describe("misc", () => {
  it("fills {name} or removes it cleanly", () => {
    expect(renderSmsBody("Hi {name}, sale today!", "Sara")).toBe("Hi Sara, sale today!");
    expect(renderSmsBody("Hi {name}, sale today!", "")).toBe("Hi, sale today!");
  });
  it("sender name rule", () => {
    expect(SENDER_NAME_RE.test("BlueField")).toBe(true);
    expect(SENDER_NAME_RE.test("Blue Field")).toBe(false);
    expect(SENDER_NAME_RE.test("1Blue")).toBe(false);
    expect(SENDER_NAME_RE.test("Ab")).toBe(false);
    expect(SENDER_NAME_RE.test("Abcdefghijkl")).toBe(false);
  });
  it("provider choice from env", () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1" })).toBeNull();
    expect(providerFromEnv({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM: "+1555" })?.name).toBe("twilio");
    expect(providerFromEnv({ SMS_PROVIDER: "infobip", INFOBIP_BASE_URL: "x.api.infobip.com", INFOBIP_API_KEY: "k" })?.name).toBe("infobip");
    expect(providerFromEnv({ SMS_PROVIDER: "fake" })?.name).toBe("fake");
  });
  it("included SMS per subscription", () => {
    expect(includedSms("monthly")).toBe(200);
    expect(includedSms("yearly")).toBe(2400);
  });
});
