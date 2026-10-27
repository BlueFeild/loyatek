import { beforeEach, describe, expect, it, vi } from "vitest";

// شركة A مشتركة في الـ AI، شركة B مش مشتركة وكمان موقوفة
const state = { tenants: [] as any[], suspended: new Set<string>() };

vi.mock("../config/db", () => ({
  prisma: { tenant: { findUnique: async ({ where }: any) => state.tenants.find((t) => t.id === where.id) ?? null } },
}));
vi.mock("../utils/platform-config", () => ({ tenantGraceDays: async () => 3 }));
vi.mock("../utils/account-access", () => ({
  checkAccess: async (_userId: string, tenantId: string) =>
    state.suspended.has(tenantId) ? { code: "ACCOUNT_SUSPENDED", message: "This account is paused" } : null,
}));

import { requireAuth } from "../middleware/auth";
import { clearModuleAccessCache, requireModule } from "../middleware/module-access";
import { bypassesAccountChecks, signAccessToken, type AccessTokenPayload } from "../utils/jwt";
import { MAX_RANGE_CHUNK, assetEtag, planAssetResponse } from "../modules/ai/asset-http";

type Outcome = { passed: boolean; status?: number; body?: any };

function run(mw: (req: any, res: any, next: () => void) => unknown, req: any): Promise<Outcome> {
  return new Promise((resolve) => {
    const res: any = { status: (code: number) => ({ json: (body: any) => resolve({ passed: false, status: code, body }) }) };
    mw(req, res, () => resolve({ passed: true }));
  });
}

const base = { userId: "u", role: "OWNER", branchId: null, isSuperAdmin: false };
const tokenFor = (p: Partial<AccessTokenPayload> & { tenantId: string }) => `Bearer ${signAccessToken({ ...base, ...p })}`;

beforeEach(() => {
  clearModuleAccessCache();
  state.tenants = [
    { id: "A", subscribedModules: ["ai"], moduleExpirations: {}, trialExpiresAt: null, accountStatus: "ACTIVE" },
    { id: "B", subscribedModules: [], moduleExpirations: {}, trialExpiresAt: null, accountStatus: "SUSPENDED" },
  ];
  state.suspended = new Set(["B"]);
});

describe("switch tokens are checked like a normal login", () => {
  it("only super admin and 'manage' (or old tokens without a kind) bypass the checks", () => {
    expect(bypassesAccountChecks({ isSuperAdmin: true })).toBe(true);
    expect(bypassesAccountChecks({ isSuperAdmin: false, impersonatedBy: "sa", impersonationKind: "manage" })).toBe(true);
    expect(bypassesAccountChecks({ isSuperAdmin: false, impersonatedBy: "sa" })).toBe(true);
    expect(bypassesAccountChecks({ isSuperAdmin: false, impersonatedBy: "owner", impersonationKind: "switch" })).toBe(false);
    expect(bypassesAccountChecks({ isSuperAdmin: false })).toBe(false);
  });
  it("switching into a suspended company is refused (403 ACCOUNT_SUSPENDED); manage still opens it", async () => {
    const sw = await run(requireAuth, { headers: { authorization: tokenFor({ tenantId: "B", impersonatedBy: "owner", impersonationKind: "switch" }) } });
    expect(sw).toMatchObject({ passed: false, status: 403, body: { code: "ACCOUNT_SUSPENDED" } });
    const manage = await run(requireAuth, { headers: { authorization: tokenFor({ tenantId: "B", impersonatedBy: "sa", impersonationKind: "manage" }) } });
    expect(manage.passed).toBe(true);
    expect((await run(requireAuth, { headers: { authorization: tokenFor({ tenantId: "A" }) } })).passed).toBe(true);
  });
  it("a switch token needs the module subscription; manage and old tokens pass like before", async () => {
    const guard = requireModule("ai");
    const blocked = await run(guard, { auth: { ...base, tenantId: "B", impersonatedBy: "owner", impersonationKind: "switch" } });
    expect(blocked).toMatchObject({ passed: false, status: 403, body: { code: "MODULE_INACTIVE" } });
    expect((await run(guard, { auth: { ...base, tenantId: "A", impersonatedBy: "owner", impersonationKind: "switch" } })).passed).toBe(true);
    expect((await run(guard, { auth: { ...base, tenantId: "B", impersonatedBy: "sa", impersonationKind: "manage" } })).passed).toBe(true);
    expect((await run(guard, { auth: { ...base, tenantId: "B", impersonatedBy: "sa" } })).passed).toBe(true);
  });
});

describe("AI asset responses (ETag / 304 / Range)", () => {
  const size = 10_000_000;
  const etag = assetEtag({ id: "abc", size });
  it("same version in the browser → 304; no headers → 200", () => {
    expect(planAssetResponse({ size, etag, ifNoneMatch: etag })).toEqual({ status: 304 });
    expect(planAssetResponse({ size, etag, ifNoneMatch: `"other", W/${etag}` })).toEqual({ status: 304 });
    expect(planAssetResponse({ size, etag, ifNoneMatch: '"other"' })).toEqual({ status: 200 });
    expect(planAssetResponse({ size, etag })).toEqual({ status: 200 });
  });
  it("ranges → 206 with the right slice (open ranges capped), suffix ranges, bad ones", () => {
    expect(planAssetResponse({ size, etag, range: "bytes=0-99" })).toEqual({ status: 206, start: 0, end: 99 });
    expect(planAssetResponse({ size, etag, range: "bytes=100-" })).toEqual({ status: 206, start: 100, end: 100 + MAX_RANGE_CHUNK - 1 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=100-" })).toEqual({ status: 206, start: 100, end: 499 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=400-9999" })).toEqual({ status: 206, start: 400, end: 499 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=-100" })).toEqual({ status: 206, start: 400, end: 499 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=500-" })).toEqual({ status: 416 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=50-10" })).toEqual({ status: 416 });
    expect(planAssetResponse({ size: 500, etag, range: "bytes=0-1,5-9" })).toEqual({ status: 200 }); // أكتر من جزء = الملف كله
  });
});
