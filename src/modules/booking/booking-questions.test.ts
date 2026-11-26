import { describe, expect, it } from "vitest";
import { answersText, questionsSchema, resolveAnswers } from "./booking-questions";

const qs = [
  { id: "size", label: "Car size", required: true, options: [{ id: "s", label: "Small" }, { id: "suv", label: "SUV", priceUsd: 5 }] },
  { id: "first", label: "First visit?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] },
];

describe("booking questions", () => {
  it("adds the price of the chosen answer", () => {
    const r = resolveAnswers(qs, { size: "suv", first: "y" });
    expect(r.extraUsd).toBe(5);
    expect(answersText(r.answers)).toBe("Car size: SUV · First visit?: Yes");
  });
  it("refuses a missing required answer or an unknown choice", () => {
    expect(() => resolveAnswers(qs, {})).toThrow(/Car size/);
    expect(() => resolveAnswers(qs, { size: "truck" })).toThrow(/Car size/);
  });
  it("optional question can be skipped; bad saved JSON = no questions", () => {
    expect(resolveAnswers(qs, { size: "s" }).answers).toHaveLength(1);
    expect(resolveAnswers({ broken: true }, undefined).extraUsd).toBe(0);
  });
  it("schema: max 3 questions, unique ids, 2+ choices", () => {
    expect(questionsSchema.safeParse([...qs, { ...qs[1], id: "a" }, { ...qs[1], id: "b" }]).success).toBe(false);
    expect(questionsSchema.safeParse([qs[0], { ...qs[1], id: "size" }]).success).toBe(false);
    expect(questionsSchema.safeParse([{ ...qs[1], options: [qs[1].options[0]] }]).success).toBe(false);
  });
});
