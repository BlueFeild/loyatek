import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { keywordMatches, matchAutoReply, normalizeForMatch, renderBotReply } from "../modules/whatsapp/bot";
import { zonedDateHourToUtc, isValidTimeZone } from "../utils/timezone";
import { isReminderDue } from "../jobs/booking-reminders";
import { verifyMetaSignature, parseWebhookPayload } from "../modules/whatsapp/webhook";
import { BOOKING_TEMPLATES, renderTemplateBody, templateName, templateParams } from "../modules/whatsapp/booking-templates";

describe("البوت: مطابقة الكلمات", () => {
  it("بيطابق عربي بأشكال مختلفة (أ/ا، ة/ه، تشكيل)", () => {
    expect(keywordMatches("عايز أحجز ميعاد", "احجز")).toBe(true);
    expect(keywordMatches("حَجْز", "حجز")).toBe(true);
    expect(keywordMatches("المنيو لو سمحت", "منيو")).toBe(false); // كلمة كاملة بس
    expect(keywordMatches("ابعتلي المنيو", "المنيو")).toBe(true);
    expect(normalizeForMatch("الصلاة")).toBe("الصلاه");
  });
  it("إنجليزي: كلمة كاملة ومن غير حساسية للحروف الكبيرة", () => {
    expect(keywordMatches("I want to BOOK please", "book")).toBe(true);
    expect(keywordMatches("check my facebook", "book")).toBe(false);
    expect(keywordMatches("Book!", "book")).toBe(true);
  });
  it("أول قاعدة مفعّلة بالترتيب هي اللي بترد", () => {
    const rules = [
      { id: "b", keywords: ["menu", "منيو"], reply: "menu", enabled: true, sortOrder: 1 },
      { id: "a", keywords: ["book", "حجز"], reply: "book", enabled: true, sortOrder: 0 },
      { id: "c", keywords: ["book"], reply: "disabled", enabled: false, sortOrder: -1 },
    ];
    expect(matchAutoReply("book and menu", rules)?.id).toBe("a");
    expect(matchAutoReply("عايز منيو", rules)?.id).toBe("b");
    expect(matchAutoReply("hello", rules)).toBeNull();
  });
  it("المتغيرات في الرد بتتملي، والمجهولة بتفضل زي ما هي", () => {
    expect(renderBotReply("Hi {name}! Book here: {booking_link} {unknown}", { name: "Fatima", booking_link: "https://x/book/s" })).toBe(
      "Hi Fatima! Book here: https://x/book/s {unknown}"
    );
  });
});

describe("المنطقة الزمنية + التذكير", () => {
  it("الساعة 4 العصر بتوقيت قطر = 1 الضهر UTC", () => {
    expect(zonedDateHourToUtc("2026-10-17", 16, "Asia/Qatar").toISOString()).toBe("2026-10-17T13:00:00.000Z");
  });
  it("القاهرة في التوقيت الصيفي والشتوي", () => {
    expect(zonedDateHourToUtc("2026-07-01", 10, "Africa/Cairo").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedDateHourToUtc("2026-12-01", 10, "Africa/Cairo").toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });
  it("مناطق زمنية غلط بتترفض", () => {
    expect(isValidTimeZone("Asia/Qatar")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
  it("قرار التذكير: قبل 24 ساعة يبعت، قبلها يستنى، بعد الميعاد لأ، والحجز المتأخر لأ", () => {
    const appointmentAt = new Date("2026-10-17T13:00:00Z");
    const createdAt = new Date("2026-10-10T10:00:00Z");
    const at = (iso: string) => isReminderDue({ appointmentAt, createdAt, hoursBefore: 24, now: new Date(iso) });
    expect(at("2026-10-16T10:00:00Z")).toBe("wait");
    expect(at("2026-10-16T13:00:00Z")).toBe("send");
    expect(at("2026-10-17T12:00:00Z")).toBe("send");
    expect(at("2026-10-17T13:00:00Z")).toBe("skip");
    expect(isReminderDue({ appointmentAt, createdAt: new Date("2026-10-17T02:00:00Z"), hoursBefore: 24, now: new Date("2026-10-17T03:00:00Z") })).toBe("skip");
  });
});

describe("Webhook من Meta", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const raw = Buffer.from(JSON.stringify({ hello: "world" }));
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  it("التوقيع الصح بيتقبل، والغلط أو الناقص بيترفض", () => {
    expect(verifyMetaSignature(raw, sig, secret)).toBe(true);
    expect(verifyMetaSignature(raw, sig, "another-secret-value-123456")).toBe(false);
    expect(verifyMetaSignature(Buffer.from("tampered"), sig, secret)).toBe(false);
    expect(verifyMetaSignature(raw, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=abc", secret)).toBe(false);
  });
  it("بيطلّع الرسايل (نص / زرار) والحالات واسم العميل", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1111" },
                contacts: [{ wa_id: "97455512345", profile: { name: "Fatima" } }],
                messages: [
                  { from: "97455512345", id: "wamid.1", type: "text", text: { body: "حجز" } },
                  { from: "97455512345", id: "wamid.2", type: "interactive", interactive: { button_reply: { title: "Menu" } } },
                  { from: "97455512345", id: "wamid.3", type: "image", image: {} },
                ],
                statuses: [{ id: "wamid.out", status: "read" }, { id: "wamid.bad", status: "failed", errors: [{ title: "Re-engagement message" }] }],
              },
            },
          ],
        },
      ],
    };
    const [batch] = parseWebhookPayload(payload);
    expect(batch.phoneNumberId).toBe("1111");
    expect(batch.messages.map((m) => [m.text, m.name])).toEqual([["حجز", "Fatima"], ["Menu", "Fatima"], ["[image]", "Fatima"]]);
    expect(batch.statuses).toEqual([{ id: "wamid.out", status: "read", error: undefined }, { id: "wamid.bad", status: "failed", error: "Re-engagement message" }]);
    expect(parseWebhookPayload({ object: "page" })).toEqual([]);
  });
});

describe("قوالب الحجز المعتمدة", () => {
  it("مفيش قالب بيبدأ أو بيخلص بمتغير (Meta بترفض ده)", () => {
    for (const def of Object.values(BOOKING_TEMPLATES)) {
      for (const body of Object.values(def.body)) {
        expect(body.trim().startsWith("{{")).toBe(false);
        expect(body.trim().endsWith("}}")).toBe(false);
        const vars = new Set(Array.from(body.matchAll(/\{\{(\d+)\}\}/g), (m) => m[1]));
        expect(vars.size).toBe(def.params.length);
        expect(def.example.length).toBe(def.params.length);
      }
    }
  });
  it("المتغيرات بتتملي بالترتيب الصح، والاسم حروف صغيرة", () => {
    const params = templateParams("BOOKING_CONFIRMATION", { name: "Fatima", business: "Glow", date: "17/10/2026", time: "16:00" });
    expect(params).toEqual(["Fatima", "Glow", "17/10/2026", "16:00"]);
    expect(renderTemplateBody("BOOKING_CONFIRMATION", "en", params)).toBe(
      "Hello Fatima, your booking at Glow is confirmed for 17/10/2026 at 16:00. Reply to this message if you need to change it."
    );
    expect(templateName("BOOKING_REMINDER", "ar")).toMatch(/^[a-z0-9_]+$/);
  });
});
