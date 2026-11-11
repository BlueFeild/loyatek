import { describe, expect, it } from "vitest";
import { keepKnownServices, pageDesignFields, serviceDetailsSchema, updateResourceSchema } from "../modules/booking/page-design";
import { z } from "zod";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const design = z.object(pageDesignFields);

describe("booking page design", () => {
  it("accepts a template, colors and images", () => {
    const r = design.safeParse({
      pageTemplate: "mint",
      pageStyle: { accent: "#14B8A6", font: "elegant" },
      coverDataUrl: PNG,
      heroTitle: "Healthy smile",
      serviceDetails: { Cleaning: { imageDataUrl: PNG, description: "Gentle cleaning", durationMin: 45 } },
    });
    expect(r.success).toBe(true);
  });

  it("refuses unknown templates, bad colors and SVG images", () => {
    expect(design.safeParse({ pageTemplate: "neon" }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { accent: "red" } }).success).toBe(false);
    expect(design.safeParse({ coverDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }).success).toBe(false);
    expect(design.safeParse({ coverDataUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { accent: "#123456", extra: 1 } }).success).toBe(false);
  });

  it("limits service details", () => {
    expect(serviceDetailsSchema.safeParse({ A: { durationMin: 2 } }).success).toBe(false);
    expect(serviceDetailsSchema.safeParse({ A: { description: "x".repeat(201) } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => ["S" + i, {}]));
    expect(serviceDetailsSchema.safeParse(many).success).toBe(false);
  });

  it("validates specialist photo and title", () => {
    expect(updateResourceSchema.safeParse({ title: "Orthodontist", photoDataUrl: PNG }).success).toBe(true);
    expect(updateResourceSchema.safeParse({ photoDataUrl: null }).success).toBe(true);
    expect(updateResourceSchema.safeParse({ tenantId: "x" }).success).toBe(false);
  });

  it("drops details of services that no longer exist", () => {
    expect(keepKnownServices({ A: 1, B: 2 }, ["B"])).toEqual({ B: 2 });
  });
});

describe("booking page design: background and layout", () => {
  it("accepts the new templates, a background and layout choices", () => {
    const r = design.safeParse({
      pageTemplate: "sunset",
      pageStyle: { background: { type: "image", imageDataUrl: PNG, dim: 30 }, layout: "grid", hero: "center", corners: "round" },
    });
    expect(r.success).toBe(true);
    expect(design.safeParse({ pageStyle: { background: { type: "gradient", gradient: "aurora" } } }).success).toBe(true);
    expect(design.safeParse({ pageStyle: { background: { type: "color", color: "#ffeedd" } } }).success).toBe(true);
  });

  it("refuses bad background values", () => {
    expect(design.safeParse({ pageStyle: { background: { type: "video" } } }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { background: { type: "gradient", gradient: "neon" } } }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { background: { type: "image", imageDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } } }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { background: { type: "image", dim: 95 } } }).success).toBe(false);
    expect(design.safeParse({ pageStyle: { layout: "carousel" } }).success).toBe(false);
  });
});
