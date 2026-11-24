import { describe, expect, it } from "vitest";
import { SocialAccountService } from "../modules/social/social-account.service";
import type { DiscoveredAccount } from "../modules/social/social-types";
import { payerView } from "../utils/payer-view";
import { imageDataUrlSchema } from "../utils/image-data-url";
import { prismaErrorResponse } from "../utils/prisma-errors";
import { csvCell } from "../modules/seats/tickets-admin.service";
import { openSecret, sealSecret } from "../config/db";

process.env.JWT_REFRESH_SECRET ||= "unit-test-refresh-secret";

const page = (externalId: string, name: string): DiscoveredAccount => ({
  platform: "FACEBOOK",
  externalId,
  name,
  username: null,
  pictureUrl: null,
  parentId: null,
  accessToken: "page-token-" + externalId,
  tokenExpiresAt: null,
});

function service(takenElsewhere: string[]) {
  const saved: DiscoveredAccount[] = [];
  const store: any = {
    upsertAccounts: async (_t: string, _u: string | null, accounts: DiscoveredAccount[]) => void saved.push(...accounts),
    listAccounts: async () => saved.map((a) => ({ id: a.externalId, platform: a.platform, name: a.name })),
    activeElsewhere: async (_t: string, accounts: { externalId: string }[]) => accounts.map((a) => a.externalId).filter((id) => takenElsewhere.includes(id)),
  };
  return { saved, svc: (found: DiscoveredAccount[]) => new SocialAccountService(store, { discoverAccounts: async () => found }) };
}

describe("security P2 (audit 2026-11-23)", () => {
  it("MSG-07: a page connected in another company is not connected here", async () => {
    const one = service(["p1"]);
    await expect(one.svc([page("p1", "Other's page")]).connectMeta("t", "u", { accessToken: "x" })).rejects.toMatchObject({ status: 409, code: "ACCOUNT_CONNECTED_ELSEWHERE" });
    expect(one.saved).toHaveLength(0);

    const mixed = service(["p1"]);
    const r = await mixed.svc([page("p1", "Other's page"), page("p2", "My page")]).connectMeta("t", "u", { accessToken: "x" });
    expect(mixed.saved.map((a) => a.externalId)).toEqual(["p2"]);
    expect(r.connected).toBe(1);
    expect(r.warning).toMatch(/Other's page/);
  });

  it("COM-09: payer view drops private fields but keeps the confirmation", () => {
    const v = payerView({ id: "b1", hour: 10, customerName: "Nora", customerPhone: "+974", customerEmail: "n@x", note: "secret", myFatoorahPaymentUrl: "https://pay", tenantId: "t", resource: { id: "r", name: "Dr", tenantId: "t", photoDataUrl: "big" } });
    expect(v).toEqual({ id: "b1", hour: 10, customerName: "Nora", resource: { id: "r", name: "Dr" } });
  });

  it("COM-14: only real image data URLs", () => {
    const ok = (v: unknown) => imageDataUrlSchema().safeParse(v).success;
    expect(ok("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(ok("data:image/jpeg;base64,/9j/4AAQ")).toBe(true);
    expect(ok("")).toBe(true);
    expect(ok("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(ok("data:text/html;base64,PGh0bWw+")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("data:image/png;base64,abc)\" onerror=")).toBe(false);
  });

  it("ERP-14: known database errors get a clear status instead of 500", () => {
    expect(prismaErrorResponse({ code: "P2002" })?.status).toBe(409);
    expect(prismaErrorResponse({ code: "P2025" })?.status).toBe(404);
    expect(prismaErrorResponse({ name: "PrismaClientValidationError" })?.status).toBe(400);
    expect(prismaErrorResponse(new Error("boom"))).toBeNull();
  });

  it("SA-01: CSV cells can't start a spreadsheet formula", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+97455551234")).toBe('"+97455551234"');
  });

  it("MSG-08: WhatsApp secrets are encrypted at rest and read back as plain text", () => {
    const sealed = sealSecret("EAAG-token") as string;
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("EAAG-token");
    expect(sealSecret(sealed)).toBe(sealed); // مايتشفّرش مرتين
    expect(openSecret(sealed)).toBe("EAAG-token");
    expect(openSecret("old-plain-token")).toBe("old-plain-token"); // القيم القديمة بتتقري زي ما هي
    expect(sealSecret(null)).toBeNull();
  });
});
