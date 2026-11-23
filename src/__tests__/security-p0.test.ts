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

describe("security P1 (audit 2026-11-23)", () => {
  it("private / internal addresses are blocked, public ones allowed", async () => {
    const { isPrivateAddress } = await import("../modules/integrations/webhook-signing");
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "198.18.0.1", "198.19.255.1", "192.0.0.8", "100.64.0.1", "::1", "::", "fc00::1", "fe80::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "2002:a9fe:a9fe::1", "::127.0.0.1", "not-an-ip"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "198.20.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    }
  });

  it("raw database / server errors are recognised so they are hidden", async () => {
    const { isInternalErrorMessage } = await import("../middleware/security-headers");
    expect(isInternalErrorMessage("Invalid `prisma.account.upsert()` invocation in /app/src/a.ts:74:20 Unique constraint failed")).toBe(true);
    expect(isInternalErrorMessage("connect ECONNREFUSED 127.0.0.1:5432")).toBe(true);
    expect(isInternalErrorMessage("failed in E:\\customers\\app\\src\\modules\\x.ts:12")).toBe(true);
    expect(isInternalErrorMessage("Invoice is already issued")).toBe(false);
    expect(isInternalErrorMessage("This email already has a BlueField account")).toBe(false);
  });
});
