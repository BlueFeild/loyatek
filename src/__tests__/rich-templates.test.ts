import { describe, expect, it } from "vitest";
import {
  buildCarouselCreateComponents,
  buildSendComponents,
  carouselCardSchema,
  carouselCardsProblem,
  renderTemplatePreview,
  templateImages,
  templateVarCount,
  type StoredCard,
} from "../modules/whatsapp/rich-templates";

const card = (text: string, buttons: StoredCard["buttons"]): StoredCard => ({ imageDataUrl: "data:image/jpeg;base64,AAAA", bodyText: text, buttons });
const shop = { type: "URL" as const, text: "Shop now", url: "https://example.com/a" };
const later = { type: "QUICK_REPLY" as const, text: "Later" };

describe("carousel validation", () => {
  const input = (buttons: any[]) => ({ imageBase64: "AAAAAAAAAAAA", imageMimeType: "image/jpeg" as const, bodyText: "Card", buttons });
  it("needs 2–10 cards", () => {
    expect(carouselCardsProblem([input([later])])).toMatch(/at least 2/);
    expect(carouselCardsProblem(Array.from({ length: 11 }, () => input([later])))).toMatch(/up to 10/);
    expect(carouselCardsProblem([input([shop, later]), input([shop, later])])).toBeNull();
  });
  it("all cards need the same button types in the same order", () => {
    expect(carouselCardsProblem([input([shop, later]), input([later, shop])])).toMatch(/same buttons/);
    expect(carouselCardsProblem([input([shop]), input([shop, later])])).toMatch(/same buttons/);
  });
  it("card text ≤160, no blanks, 1–2 buttons, https links", () => {
    expect(carouselCardSchema.safeParse(input([later])).success).toBe(true);
    expect(carouselCardSchema.safeParse({ ...input([later]), bodyText: "x".repeat(161) }).success).toBe(false);
    expect(carouselCardSchema.safeParse({ ...input([later]), bodyText: "Hi {{1}}" }).success).toBe(false);
    expect(carouselCardSchema.safeParse(input([])).success).toBe(false);
    expect(carouselCardSchema.safeParse(input([later, later, later])).success).toBe(false);
    expect(carouselCardSchema.safeParse(input([{ ...shop, url: "http://example.com" }])).success).toBe(false);
  });
});

describe("Meta shapes", () => {
  const cards = [card("Fresh veggies", [shop, later]), card("Cleaning deals", [shop, later])];
  it("create: body + CAROUSEL with a header handle per card", () => {
    const comps: any = buildCarouselCreateComponents("Hi {{1}}! Weekend deals", ["Sara"], cards, ["h1", "h2"]);
    expect(comps[0]).toEqual({ type: "BODY", text: "Hi {{1}}! Weekend deals", example: { body_text: [["Sara"]] } });
    expect(comps[1].type).toBe("CAROUSEL");
    expect(comps[1].cards).toHaveLength(2);
    expect(comps[1].cards[1].components[0]).toEqual({ type: "HEADER", format: "IMAGE", example: { header_handle: ["h2"] } });
    expect(comps[1].cards[0].components[2].buttons).toEqual([
      { type: "URL", text: "Shop now", url: "https://example.com/a" },
      { type: "QUICK_REPLY", text: "Later" },
    ]);
  });
  it("send carousel: image id per card + payload for quick replies only", () => {
    const comps: any = buildSendComponents({ format: "CAROUSEL", bodyText: "Hi {{1}}", cards }, ["m1", "m2"], ["Sara"]);
    expect(comps[0]).toEqual({ type: "body", parameters: [{ type: "text", text: "Sara" }] });
    const c2 = comps[1].cards[1];
    expect(c2.card_index).toBe(1);
    expect(c2.components[0]).toEqual({ type: "header", parameters: [{ type: "image", image: { id: "m2" } }] });
    expect(c2.components).toHaveLength(2); // الصورة + الرد السريع (زرار اللينك مش محتاج حاجة)
    expect(c2.components[1]).toEqual({ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "card2_btn2" }] });
  });
  it("send single-image template: header image (the old campaign bug)", () => {
    const comps: any = buildSendComponents({ format: "STANDARD", bodyText: "Sale!", headerImageDataUrl: "data:image/png;base64,AA" }, ["m9"], []);
    expect(comps).toEqual([{ type: "header", parameters: [{ type: "image", image: { id: "m9" } }] }]);
  });
  it("images to upload + preview text", () => {
    expect(templateImages({ format: "CAROUSEL", bodyText: "x", cards })).toHaveLength(2);
    expect(templateImages({ format: "STANDARD", bodyText: "x", headerImageDataUrl: null })).toEqual([]);
    expect(templateVarCount("Hi {{1}} {{2}}")).toBe(2);
    expect(renderTemplatePreview({ format: "CAROUSEL", bodyText: "Hi {{1}}", cards }, ["Sara"])).toContain("🃏 2. Cleaning deals [Shop now | Later]");
  });
});
