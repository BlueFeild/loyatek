import { describe, expect, it } from "vitest";
import {
  LIMITS,
  SECTION_IDS,
  contentSchema,
  decodeImageDataUrl,
  keepKnownPhotos,
  lastDays,
  normalizeSections,
  publicInquirySchema,
  readContent,
  referencedPhotoIds,
  settingsSchema,
  photoSchema,
} from "../modules/website/website.schemas";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("website sections order", () => {
  it("a new site gets every section once, hero first, good defaults on", () => {
    const s = normalizeSections([]);
    expect(s.map((x) => x.id)).toEqual([...SECTION_IDS]);
    expect(s.find((x) => x.id === "hero")!.on).toBe(true);
    expect(s.find((x) => x.id === "about")!.on).toBe(true);
    expect(s.find((x) => x.id === "faq")!.on).toBe(false);
  });

  it("keeps the merchant's order, drops duplicates/unknown, pins hero first and adds missing ones off", () => {
    const s = normalizeSections([
      { id: "contact", on: true },
      { id: "hero", on: false },
      { id: "faq", on: true },
      { id: "contact", on: false },
      { id: "nope", on: true },
    ]);
    expect(s[0]).toEqual({ id: "hero", on: true });
    expect(s[1]).toEqual({ id: "contact", on: true });
    expect(s[2]).toEqual({ id: "faq", on: true });
    expect(s).toHaveLength(SECTION_IDS.length);
    expect(s.find((x) => x.id === "about")!.on).toBe(false);
  });
});

describe("website content validation", () => {
  it("fills defaults from an empty object", () => {
    const c = readContent(null);
    expect(c.hero.buttons).toEqual([]);
    expect(c.hours.days).toHaveLength(7);
    expect(c.contact.form).toBe(true);
    expect(c.floatingWhatsapp).toBe(true);
  });

  it("enforces list limits", () => {
    const tooMany = Array.from({ length: LIMITS.faq + 1 }, (_, i) => ({ q: `Q${i}`, a: "A" }));
    expect(contentSchema.safeParse({ faq: { items: tooMany } }).success).toBe(false);
    const stats = Array.from({ length: LIMITS.stats + 1 }, () => ({ value: "10+", label: "years" }));
    expect(contentSchema.safeParse({ stats: { items: stats } }).success).toBe(false);
    const buttons = [{ kind: "call" }, { kind: "whatsapp" }, { kind: "book" }];
    expect(contentSchema.safeParse({ hero: { buttons } }).success).toBe(false);
  });

  it("refuses non-https links, unknown fields and bad stars", () => {
    expect(contentSchema.safeParse({ contact: { mapUrl: "javascript:alert(1)" } }).success).toBe(false);
    expect(contentSchema.safeParse({ social: { instagram: "http://x.com" } }).success).toBe(false);
    expect(contentSchema.safeParse({ hacker: 1 }).success).toBe(false);
    expect(contentSchema.safeParse({ testimonials: { items: [{ name: "A", text: "B", stars: 6 }] } }).success).toBe(false);
    expect(contentSchema.safeParse({ hero: { buttons: [{ kind: "link", url: "https://ok.example" }] } }).success).toBe(true);
  });

  it("gives items ids, removes duplicate gallery photos, cleans phone numbers", () => {
    const c = contentSchema.parse({
      services: { items: [{ title: "Cleaning", price: 50 }, { id: "keep", title: "Whitening" }] },
      gallery: { photoIds: [U1, U1, U2] },
      contact: { whatsapp: "+974 5555 1234" },
    });
    expect(c.services.items[0].id).not.toBe("");
    expect(c.services.items[1].id).toBe("keep");
    expect(c.gallery.photoIds).toEqual([U1, U2]);
    expect(c.contact.whatsapp).toBe("97455551234");
  });

  it("drops photos that don't belong to the company", () => {
    const c = contentSchema.parse({ about: { photoId: U1 }, gallery: { photoIds: [U1, U2] }, team: { members: [{ name: "Sara", photoId: U2 }] } });
    expect(referencedPhotoIds(c).sort()).toEqual([U1, U2].sort());
    const kept = keepKnownPhotos(c, new Set([U1]));
    expect(kept.gallery.photoIds).toEqual([U1]);
    expect(kept.team.members[0].photoId).toBeNull();
    expect(kept.about.photoId).toBe(U1);
  });
});

describe("website settings + public form", () => {
  it("accepts good settings and refuses SVG/unknown template", () => {
    expect(settingsSchema.safeParse({ template: "mint", language: "ar", logoDataUrl: PNG, pageStyle: { accent: "#112233", font: "elegant" } }).success).toBe(true);
    expect(settingsSchema.safeParse({ template: "night" }).success).toBe(false);
    expect(settingsSchema.safeParse({ logoDataUrl: "data:image/svg+xml;base64,AAAA" }).success).toBe(false);
    expect(photoSchema.safeParse({ kind: "gallery", dataUrl: PNG }).success).toBe(true);
  });

  it("needs a phone or an email to reply to", () => {
    expect(publicInquirySchema.safeParse({ name: "Ali", message: "Hello" }).success).toBe(false);
    expect(publicInquirySchema.safeParse({ name: "Ali", message: "Hello", email: "a@b.co" }).success).toBe(true);
    expect(publicInquirySchema.safeParse({ name: "Ali", message: "Hello", phone: "+974 5555 1234" }).success).toBe(true);
  });

  it("decodes images and builds the last days list", () => {
    expect(decodeImageDataUrl(PNG)?.mime).toBe("image/png");
    expect(decodeImageDataUrl("data:image/svg+xml;base64,AAAA")).toBeNull();
    const d = lastDays(3, new Date("2026-11-19T10:00:00Z"));
    expect(d).toEqual(["2026-11-19", "2026-11-18", "2026-11-17"]);
  });
});
