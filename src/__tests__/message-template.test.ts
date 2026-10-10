import { describe, it, expect } from "vitest";
import { renderMessageTemplate } from "../utils/messageTemplate";
import { isModuleActive, getEffectiveModules } from "../utils/modules";

describe("renderMessageTemplate", () => {
  it("fills known placeholders and leaves out the ones the merchant didn't write (no forced amount)", () => {
    expect(renderMessageTemplate("Hi {name}, order: {items}", { name: "Sara", items: "2× Latte", total: "9.00" })).toBe("Hi Sara, order: 2× Latte");
  });
  it("includes the amount only when the merchant wrote {total}", () => {
    expect(renderMessageTemplate("Total: {total}", { total: "9.00" })).toBe("Total: 9.00");
  });
  it("unknown placeholders are removed instead of leaking braces; trailing spaces trimmed", () => {
    expect(renderMessageTemplate("Hello {nope}  \nBye", {})).toBe("Hello\nBye");
  });
  it("does not execute or re-expand values (values are literal)", () => {
    expect(renderMessageTemplate("{name}", { name: "{total}", total: "9" })).toBe("{total}");
  });
});

describe("platform-owner (super admin) modules are free", () => {
  const base = { subscribedModules: [] as string[], moduleExpirations: {}, trialExpiresAt: null };
  it("normal tenant with nothing subscribed has nothing", () => {
    expect(getEffectiveModules(base)).toEqual([]);
  });
  it("platform owner has every module active, no expiry needed, even expired ones", () => {
    const t = { ...base, isPlatformOwner: true, moduleExpirations: { wallet: "2000-01-01T00:00:00Z" } };
    expect(getEffectiveModules(t).sort()).toEqual(["booking", "catalog", "erp", "linktree", "wallet", "whatsapp"]);
    expect(isModuleActive(t, "wallet")).toBe(true);
    expect(isModuleActive(t, "not-a-module")).toBe(false);
  });
});
