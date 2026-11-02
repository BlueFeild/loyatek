import { describe, expect, it } from "vitest";
import { sanitizeCopyResult } from "../modules/ai/copy-generator";

describe("sanitizeCopyResult", () => {
  it("cleans the leaked JSON / reasoning seen live from Gemini", () => {
    const out = sanitizeCopyResult({
      variants: [
        {
          text: "كريم الشعر من بلوفيلد ✨",
          hashtags: ["#بلوفيلد','#عناية_بالشعر','#قطر','#كريم_شعر','#جمال']}]}```Correcting hashtag quotation within json: Valid JSON requires"],
        },
      ],
    });
    expect(out?.variants[0].hashtags).toEqual(["#بلوفيلد", "#عناية_بالشعر", "#قطر", "#كريم_شعر", "#جمال"]);
  });

  it("cuts the text at a code fence and drops empty variants", () => {
    const out = sanitizeCopyResult({ variants: [{ text: "Hello Doha```json {}", hashtags: ["doha", "#doha"] }, { text: "```", hashtags: [] }] });
    expect(out).toEqual({ variants: [{ text: "Hello Doha", hashtags: ["#doha"] }] });
  });

  it("returns null when nothing usable is left", () => {
    expect(sanitizeCopyResult({ variants: [{ text: "```oops", hashtags: [] }] })).toBeNull();
  });
});
