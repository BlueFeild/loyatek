import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../utils/rate-limit";
import { isManageSession } from "../utils/jwt";
import { movementSchema } from "../modules/inventory/inventory.routes";

describe("security P0 (audit 2026-11-23)", () => {
  it("sliding window limiter blocks after the limit and forgets old hits", () => {
    const l = new SlidingWindowLimiter(3, 1000);
    expect([l.hit("a", 0), l.hit("a", 10), l.hit("a", 20)]).toEqual([false, false, false]);
    expect(l.hit("a", 30)).toBe(true);
    expect(l.isLimited("a", 500)).toBe(true);
    expect(l.isLimited("a", 1031)).toBe(false);
    expect(l.isLimited("b", 30)).toBe(false);
    l.reset("a");
    expect(l.isLimited("a", 40)).toBe(false);
  });

  it("manage sessions are told apart from owners switching companies", () => {
    expect(isManageSession({ impersonatedBy: "sa", impersonationKind: "manage" })).toBe(true);
    expect(isManageSession({ impersonatedBy: "sa" })).toBe(true); // توكن قديم من غير نوع
    expect(isManageSession({ impersonatedBy: "owner", impersonationKind: "switch" })).toBe(false);
    expect(isManageSession({})).toBe(false);
  });

  it("stock movements need a positive quantity (adjustment: non-zero)", () => {
    const ok = (b: unknown) => movementSchema.safeParse(b).success;
    expect(ok({ type: "OUT", quantity: -100 })).toBe(false);
    expect(ok({ type: "WASTAGE", quantity: 0 })).toBe(false);
    expect(ok({ type: "IN", quantity: 5 })).toBe(true);
    expect(ok({ type: "ADJUSTMENT", quantity: -2 })).toBe(true);
    expect(ok({ type: "ADJUSTMENT", quantity: 0 })).toBe(false);
    expect(ok({ type: "IN", quantity: 1.5 })).toBe(false);
  });
});
