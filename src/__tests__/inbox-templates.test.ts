import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { renderTemplateText, templateParamCount } from "../modules/whatsapp/inbox-templates";

describe("inbox templates", () => {
  it("counts blanks by the highest {{n}}", () => {
    expect(templateParamCount("Hi {{1}}, your order {{2}} is ready. Thanks {{1}}")).toBe(2);
    expect(templateParamCount("No blanks here")).toBe(0);
    expect(templateParamCount("Spaces {{ 3 }} ok")).toBe(3);
  });
  it("renders the text the customer actually sees", () => {
    expect(renderTemplateText("Hi {{1}}, order {{2}}", ["Sara", "#12"])).toBe("Hi Sara, order #12");
    expect(renderTemplateText("Hi {{1}} {{2}}", ["Sara"])).toBe("Hi Sara -");
  });
});
