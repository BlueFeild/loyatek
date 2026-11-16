import { describe, expect, it } from "vitest";
import { z } from "zod";
import { linktreeDesignFields, LINKTREE_TEMPLATES } from "../modules/linktree/linktree-design";

const schema = z.object(linktreeDesignFields);
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("Link-in-Bio design", () => {
  it("accepts every template and a full style", () => {
    for (const t of LINKTREE_TEMPLATES) expect(schema.safeParse({ pageTemplate: t }).success).toBe(true);
    const ok = schema.safeParse({ pageStyle: { shape: "pill", font: "elegant", featured: true, socialRow: true, coverStyle: "hero", animate: false }, coverDataUrl: PNG });
    expect(ok.success).toBe(true);
  });
  it("refuses unknown templates, unknown style keys and SVG covers", () => {
    expect(schema.safeParse({ pageTemplate: "matrix" }).success).toBe(false);
    expect(schema.safeParse({ pageStyle: { shape: "blob" } }).success).toBe(false);
    expect(schema.safeParse({ pageStyle: { evil: "<script>" } }).success).toBe(false);
    expect(schema.safeParse({ coverDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
  });
  it("allows clearing the cover and the style", () => {
    expect(schema.safeParse({ coverDataUrl: null, pageStyle: null }).success).toBe(true);
  });
});
