import { describe, expect, it } from "vitest";
import {
  buildSendComponents,
  buildStandardCreateComponents,
  headerTypeForMime,
  needsRichSend,
  normalizeStandardButtons,
  renderTemplatePreview,
  standardButtonSchema,
  templateButtons,
  templateImages,
} from "../modules/whatsapp/rich-templates";

describe("rich standard WhatsApp templates (video/PDF header, footer, 3 buttons)", () => {
  it("maps file types to header types", () => {
    expect(headerTypeForMime("image/png")).toBe("IMAGE");
    expect(headerTypeForMime("video/mp4")).toBe("VIDEO");
    expect(headerTypeForMime("application/pdf")).toBe("DOCUMENT");
    expect(headerTypeForMime("image/gif")).toBeNull();
  });

  it("groups link/call buttons before quick replies and checks WhatsApp's limits", () => {
    const r = normalizeStandardButtons([
      { type: "QUICK_REPLY", text: "Shop in-store" },
      { type: "URL", text: "Read more", url: "https://shop.example.com" },
    ]);
    expect(r.problem).toBeNull();
    expect(r.buttons.map((b) => b.type)).toEqual(["URL", "QUICK_REPLY"]);

    expect(normalizeStandardButtons([{ type: "PHONE_NUMBER", text: "Call", phone: "+974 5555-1234" }]).buttons[0]).toEqual({ type: "PHONE_NUMBER", text: "Call", phone: "+97455551234" });
    expect(normalizeStandardButtons([{ type: "PHONE_NUMBER", text: "A", phone: "97455551234" }, { type: "PHONE_NUMBER", text: "B", phone: "97455551235" }]).problem).toMatch(/only 1 call/);
    const url = (t: string) => ({ type: "URL" as const, text: t, url: "https://a.com" });
    expect(normalizeStandardButtons([url("a"), url("b"), url("c")]).problem).toMatch(/2 link/);
    expect(normalizeStandardButtons([{ type: "QUICK_REPLY", text: "Yes" }, { type: "QUICK_REPLY", text: "yes" }]).problem).toMatch(/same text/);
    expect(normalizeStandardButtons([url("a"), { type: "QUICK_REPLY", text: "b" }, { type: "QUICK_REPLY", text: "c" }, { type: "QUICK_REPLY", text: "d" }]).problem).toMatch(/up to 3/);
  });

  it("refuses http links and bad phone numbers", () => {
    expect(standardButtonSchema.safeParse({ type: "URL", text: "x", url: "http://a.com" }).success).toBe(false);
    expect(standardButtonSchema.safeParse({ type: "PHONE_NUMBER", text: "x", phone: "abc" }).success).toBe(false);
  });

  it("builds the Meta create payload with video header, footer and buttons", () => {
    const c = buildStandardCreateComponents({
      headerType: "VIDEO",
      headerHandle: "h:1",
      bodyText: "Hi {{1}}, the sale started",
      bodyExamples: ["Sara"],
      footerText: "To opt-out, reply STOP",
      buttons: [
        { type: "URL", text: "Read more", url: "https://shop.example.com" },
        { type: "PHONE_NUMBER", text: "Call us", phone: "+97455551234" },
        { type: "QUICK_REPLY", text: "Shop in-store" },
      ],
    });
    expect(c[0]).toEqual({ type: "HEADER", format: "VIDEO", example: { header_handle: ["h:1"] } });
    expect(c[1]).toEqual({ type: "BODY", text: "Hi {{1}}, the sale started", example: { body_text: [["Sara"]] } });
    expect(c[2]).toEqual({ type: "FOOTER", text: "To opt-out, reply STOP" });
    expect(c[3]).toEqual({
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Read more", url: "https://shop.example.com" },
        { type: "PHONE_NUMBER", text: "Call us", phone_number: "+97455551234" },
        { type: "QUICK_REPLY", text: "Shop in-store" },
      ],
    });
  });

  it("sends the right header type and quick reply payloads", () => {
    const video = { format: "STANDARD", bodyText: "Hi {{1}}", headerType: "VIDEO", headerMediaDataUrl: "data:video/mp4;base64,AAAA", buttons: [{ type: "URL", text: "Read more", url: "https://a.com" }, { type: "QUICK_REPLY", text: "Shop" }] };
    expect(needsRichSend(video)).toBe(true);
    expect(templateImages(video)).toEqual(["data:video/mp4;base64,AAAA"]);
    expect(buildSendComponents(video, ["m1"], ["Sara"])).toEqual([
      { type: "header", parameters: [{ type: "video", video: { id: "m1" } }] },
      { type: "body", parameters: [{ type: "text", text: "Sara" }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "btn2" }] },
    ]);

    const pdf = { bodyText: "Menu", headerType: "DOCUMENT", headerMediaDataUrl: "data:application/pdf;base64,AAAA", headerFileName: "menu.pdf" };
    expect(buildSendComponents(pdf, ["m2"], [])[0]).toEqual({ type: "header", parameters: [{ type: "document", document: { id: "m2", filename: "menu.pdf" } }] });
  });

  it("keeps old templates working (image header + single link button, plain text)", () => {
    const old = { bodyText: "Hi", headerImageDataUrl: "data:image/jpeg;base64,AAAA", buttonText: "Open", buttonUrl: "https://a.com" };
    expect(templateButtons(old)).toEqual([{ type: "URL", text: "Open", url: "https://a.com" }]);
    expect(buildSendComponents(old, ["m3"], [])).toEqual([{ type: "header", parameters: [{ type: "image", image: { id: "m3" } }] }]);
    expect(needsRichSend({ bodyText: "plain" })).toBe(false);
    expect(renderTemplatePreview({ bodyText: "Sale {{1}}", headerType: "VIDEO", headerMediaDataUrl: "x", footerText: "Reply STOP", buttons: [{ type: "QUICK_REPLY", text: "Shop" }] }, ["now"])).toBe("🎬 Sale now\nReply STOP\n[Shop]");
  });
});
