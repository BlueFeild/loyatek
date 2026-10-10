import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "crypto";
import jwt from "jsonwebtoken";
import { computeStamp } from "../modules/wallet/stamp-logic";
import {
  GoogleRequester,
  buildLoyaltyClass,
  buildLoyaltyObject,
  buildSaveToWalletUrl,
  ensureLoyaltyClass,
  loadGoogleWalletConfig,
  patchLoyaltyObjectState,
  upsertLoyaltyObject,
} from "../modules/wallet/google-wallet.service";
import { solidColorPng } from "../modules/wallet/png";

describe("computeStamp", () => {
  it("adds one stamp without a reward before the target", () => {
    expect(computeStamp(0, 5)).toEqual({ balance: 1, rewardsEarned: 0 });
    expect(computeStamp(3, 5)).toEqual({ balance: 4, rewardsEarned: 0 });
  });
  it("earns a gift exactly on the Nth stamp and restarts the card", () => {
    expect(computeStamp(4, 5)).toEqual({ balance: 0, rewardsEarned: 1 });
  });
  it("keeps leftovers when a balance is already above the target", () => {
    expect(computeStamp(12, 5)).toEqual({ balance: 3, rewardsEarned: 2 });
  });
  it("never goes wrong on bad input", () => {
    expect(computeStamp(-3, 5)).toEqual({ balance: 1, rewardsEarned: 0 });
    expect(computeStamp(0, 0)).toEqual({ balance: 0, rewardsEarned: 1 });
  });
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("loadGoogleWalletConfig", () => {
  it("is off when env vars are missing or broken", () => {
    expect(loadGoogleWalletConfig({} as any)).toBeNull();
    expect(loadGoogleWalletConfig({ GOOGLE_WALLET_ISSUER_ID: "1", GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: "not json" } as any)).toBeNull();
    expect(
      loadGoogleWalletConfig({ GOOGLE_WALLET_ISSUER_ID: "1", GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b" }) } as any)
    ).toBeNull();
  });
  it("parses the service account JSON and repairs escaped newlines", () => {
    const cfg = loadGoogleWalletConfig({
      GOOGLE_WALLET_ISSUER_ID: "3388000000012345",
      GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: "-----BEGIN\\nabc\\n-----END" }),
      ALLOWED_ORIGINS: "https://a.com, https://b.com",
    } as any);
    expect(cfg?.issuerId).toBe("3388000000012345");
    expect(cfg?.privateKey).toBe("-----BEGIN\nabc\n-----END");
    expect(cfg?.origins).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("Save to Google Wallet link", () => {
  it("is a valid RS256 JWT referencing the customer's pass object", () => {
    const cfg = { issuerId: "123", clientEmail: "svc@proj.iam.gserviceaccount.com", privateKey, origins: ["https://x.com"] };
    const url = buildSaveToWalletUrl(cfg, "123.cust-1");
    expect(url.startsWith("https://pay.google.com/gp/v/save/")).toBe(true);

    const token = url.replace("https://pay.google.com/gp/v/save/", "");
    const claims = jwt.verify(token, publicKey, { algorithms: ["RS256"] }) as any;
    expect(claims.iss).toBe(cfg.clientEmail);
    expect(claims.aud).toBe("google");
    expect(claims.typ).toBe("savetowallet");
    expect(claims.payload.loyaltyObjects).toEqual([{ id: "123.cust-1" }]);
    // رابط قصير - مفيش خطر حدود حجم الرابط
    expect(url.length).toBeLessThan(1500);
  });
  it("is rejected when verified with a different key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const token = buildSaveToWalletUrl({ issuerId: "1", clientEmail: "e", privateKey, origins: [] }, "1.x").split("/save/")[1];
    expect(() => jwt.verify(token, other.publicKey, { algorithms: ["RS256"] })).toThrow();
  });
});

describe("pass content", () => {
  const base = {
    issuerId: "123",
    tenantId: "t1",
    customer: { id: "c1", name: "Mona", phone: "+201000000000", memberCode: "abcdef0123456789abcdef0123456789", balance: 3 },
    stampCount: 5,
    rewardText: "Free coffee",
  };
  it("puts the member code in the QR and shows progress", () => {
    const obj: any = buildLoyaltyObject({ ...base, availableRewards: 0 });
    expect(obj.id).toBe("123.c1");
    expect(obj.classId).toBe("123.t1");
    expect(obj.barcode).toEqual({ type: "QR_CODE", value: base.customer.memberCode });
    expect(obj.loyaltyPoints.balance.string).toBe("3 / 5");
    expect(obj.textModulesData[0].body).toContain("2 more stamps");
    expect(obj.textModulesData[0].body).toContain("Free coffee");
    expect(obj.messages).toBeUndefined();
  });
  it("shows the gift and sends a push notification when a gift is earned", () => {
    const obj: any = buildLoyaltyObject({
      ...base,
      customer: { ...base.customer, balance: 0 },
      availableRewards: 1,
      message: { kind: "earned", label: "Free coffee", rewardId: "r1" },
    });
    expect(obj.textModulesData[0].header).toContain("Gift ready");
    expect(obj.messages[0].messageType).toBe("TEXT_AND_NOTIFY");
    expect(obj.messages[0].body).toBe("Free coffee");
  });
  it("replaces the gift message silently after redeeming", () => {
    const obj: any = buildLoyaltyObject({ ...base, availableRewards: 0, message: { kind: "redeemed" } });
    expect(obj.messages[0].messageType).toBe("TEXT");
    expect(obj.textModulesData[0].header).toBe("Next gift");
  });
  it("falls back to a safe colour for the class", () => {
    expect(buildLoyaltyClass({ issuerId: "1", tenantId: "t", tenantName: "Cafe", themeColor: "red", logoUrl: "https://x/l.png" }).hexBackgroundColor).toBe("#0F172A");
    expect(buildLoyaltyClass({ issuerId: "1", tenantId: "t", tenantName: "Cafe", themeColor: "#38BDF8", logoUrl: "https://x/l.png" }).hexBackgroundColor).toBe("#38BDF8");
  });
});

function fakeRequester(responses: Array<{ status: number; data?: any }>) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const req: GoogleRequester = async (method, url, body) => {
    calls.push({ method, url, body });
    return { status: 200, data: {}, ...(responses.shift() ?? {}) };
  };
  return { req, calls };
}

describe("Google Wallet API calls", () => {
  it("creates a class, and updates it when it already exists", async () => {
    const a = fakeRequester([{ status: 200 }]);
    await ensureLoyaltyClass(a.req, { id: "1.t" });
    expect(a.calls.map((c) => c.method)).toEqual(["POST"]);

    const b = fakeRequester([{ status: 409 }, { status: 200 }]);
    await ensureLoyaltyClass(b.req, { id: "1.t" });
    expect(b.calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    expect(b.calls[1].url.endsWith("/loyaltyClass/1.t")).toBe(true);
  });
  it("surfaces Google's own error message when it really fails", async () => {
    const r = fakeRequester([{ status: 403, data: { error: { message: "Issuer not authorized" } } }]);
    await expect(upsertLoyaltyObject(r.req, { id: "1.c" })).rejects.toThrow(/403.*Issuer not authorized/);
  });
  it("updates an existing pass object without resending its id in the body", async () => {
    const r = fakeRequester([{ status: 409 }, { status: 200 }]);
    await upsertLoyaltyObject(r.req, { id: "1.c", classId: "1.t", accountName: "Mona" } as any);
    expect(r.calls[1].method).toBe("PATCH");
    expect(r.calls[1].body.id).toBeUndefined();
    expect(r.calls[1].body.accountName).toBe("Mona");
  });
  it("treats a pass that was never saved (404) as nothing to update", async () => {
    const r = fakeRequester([{ status: 404 }]);
    expect(await patchLoyaltyObjectState(r.req, "1.c", {})).toBe("not-found");
    const ok = fakeRequester([{ status: 200 }]);
    expect(await patchLoyaltyObjectState(ok.req, "1.c", {})).toBe("updated");
  });
});

describe("default logo", () => {
  it("is a well-formed PNG with the requested size", () => {
    const png = solidColorPng("#38BDF8", 64);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
  });
});
