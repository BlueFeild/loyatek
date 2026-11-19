import { describe, expect, it, vi } from "vitest";
import path from "path";
import {
  AccountHealthService,
  buildAccountHealth,
  isMetaTestNumber,
  parseNameStatus,
  parseQuality,
  parseTier,
  parseVerification,
  type AccountHealthGateway,
  type FetchResult,
} from "../modules/whatsapp/account-health";

const ok = (data: Record<string, unknown>, failedFields: string[] = []): FetchResult => ({ data, failedFields });
const now = new Date("2026-11-19T10:00:00Z");

describe("account health parsing", () => {
  it("detects Meta test numbers (+1 555)", () => {
    expect(isMetaTestNumber("+1 555-677-7585")).toBe(true);
    expect(isMetaTestNumber("15556777585")).toBe(true);
    expect(isMetaTestNumber("+974 6003 3347")).toBe(false);
    expect(isMetaTestNumber("+1 415 555 0100")).toBe(false);
    expect(isMetaTestNumber(null)).toBe(false);
  });

  it("maps statuses to plain values", () => {
    expect(parseNameStatus("APPROVED")).toBe("approved");
    expect(parseNameStatus("AVAILABLE_WITHOUT_REVIEW")).toBe("approved");
    expect(parseNameStatus("PENDING_REVIEW")).toBe("pending");
    expect(parseNameStatus("DECLINED")).toBe("declined");
    expect(parseNameStatus("NONE")).toBe("none");
    expect(parseNameStatus("SOMETHING_NEW")).toBe("unknown");
    expect(parseNameStatus(null)).toBeNull();
    expect(parseQuality("GREEN")).toBe("green");
    expect(parseQuality("YELLOW")).toBe("yellow");
    expect(parseQuality("RED")).toBe("red");
    expect(parseQuality("UNKNOWN")).toBe("unknown");
    expect(parseVerification("verified")).toBe("verified");
    expect(parseVerification("pending_submission")).toBe("pending");
    expect(parseVerification("not_verified")).toBe("not_verified");
    expect(parseVerification("rejected")).toBe("rejected");
  });

  it("turns the messaging tier into a daily number", () => {
    expect(parseTier("TIER_250")).toEqual({ dailyLimit: 250, unlimited: false });
    expect(parseTier("TIER_1K")).toEqual({ dailyLimit: 1000, unlimited: false });
    expect(parseTier("TIER_100K")).toEqual({ dailyLimit: 100000, unlimited: false });
    expect(parseTier("TIER_UNLIMITED")).toEqual({ dailyLimit: null, unlimited: true });
    expect(parseTier("WEIRD")).toEqual({ dailyLimit: null, unlimited: false });
  });

  it("builds a full health view from Meta's answer", () => {
    const h = buildAccountHealth(
      ok({
        display_phone_number: "+974 6003 3347",
        verified_name: "BlueField",
        name_status: "APPROVED",
        quality_rating: "GREEN",
        messaging_limit_tier: "TIER_250",
        code_verification_status: "VERIFIED",
        platform_type: "CLOUD_API",
        throughput: { level: "STANDARD" },
        is_on_biz_app: true,
      }),
      ok({ name: "BlueField WABA", business_verification_status: "pending_submission", owner_business_info: { id: "158", name: "BLUE FIELD PHOTOGRAPHY" }, primary_funding_id: "991" }),
      { now }
    );
    expect(h.number).toMatchObject({ display: "+974 6003 3347", nameStatus: "approved", quality: "green", dailyLimit: 250, codeVerified: true, throughput: "STANDARD", onBusinessApp: true, isTestNumber: false });
    expect(h.business).toMatchObject({ ownerName: "BLUE FIELD PHOTOGRAPHY", verification: "pending", hasPaymentMethod: true });
    expect(h.links.securityCenter).toContain("business_id=158");
    expect(h.reconnect).toBeNull();
    expect(h.missingFields).toEqual([]);
  });

  it("omits fields Meta refused and keeps the rest", () => {
    const h = buildAccountHealth(
      ok({ display_phone_number: "+1 555-677-7585", quality_rating: "YELLOW" }, ["throughput", "is_on_biz_app"]),
      ok({ name: "Test WABA" }, ["primary_funding_id", "owner_business_info"]),
      { now, fallbackName: "Test Number" }
    );
    expect(h.number.isTestNumber).toBe(true);
    expect(h.number.verifiedName).toBe("Test Number");
    expect(h.number.onBusinessApp).toBeNull();
    expect(h.number.throughput).toBeNull();
    expect(h.business.hasPaymentMethod).toBeNull(); // Meta didn't answer that field -> unknown, not "no"
    expect(h.missingFields).toEqual(["throughput", "is_on_biz_app", "primary_funding_id", "owner_business_info"]);
  });

  it("says no payment method when Meta answered without one", () => {
    const h = buildAccountHealth(ok({ display_phone_number: "+974 1" }), ok({ name: "W" }), { now });
    expect(h.business.hasPaymentMethod).toBe(false);
  });

  it("flags an expired token as reconnect", () => {
    const h = buildAccountHealth({ data: {}, failedFields: ["x"], tokenProblem: "Session has expired" }, null, { now, fallbackDisplay: "+974 5" });
    expect(h.reconnect).toBe("Session has expired");
    expect(h.number.display).toBe("+974 5");
    expect(h.unreachable).toBeNull();
  });
});

describe("AccountHealthService cache", () => {
  function setup(connected = true) {
    let t = now.getTime();
    const fetchNode = vi.fn<AccountHealthGateway["fetchNode"]>(async (_tok, id) => (id === "PH" ? ok({ display_phone_number: "+974 6003 3347", quality_rating: "GREEN" }) : ok({ name: "W" })));
    const svc = new AccountHealthService(
      { connection: async () => ({ isConnected: connected, token: "tok_123456789012345", phoneNumberId: "PH", wabaId: "WB", display: null, name: null }) },
      { fetchNode },
      () => new Date(t)
    );
    return { svc, fetchNode, advance: (ms: number) => (t += ms) };
  }

  it("returns connected:false without asking Meta", async () => {
    const { svc, fetchNode } = setup(false);
    expect(await svc.get("t1")).toEqual({ connected: false });
    expect(fetchNode).not.toHaveBeenCalled();
  });

  it("caches for 5 minutes and limits manual refresh to every 20 s", async () => {
    const { svc, fetchNode, advance } = setup();
    const a = await svc.get("t1");
    expect(fetchNode).toHaveBeenCalledTimes(2); // phone + WABA
    expect((a as { cached: boolean }).cached).toBe(false);
    const b = await svc.get("t1", { refresh: true });
    expect((b as { cached: boolean }).cached).toBe(true);
    expect(fetchNode).toHaveBeenCalledTimes(2);
    advance(25_000);
    await svc.get("t1", { refresh: true });
    expect(fetchNode).toHaveBeenCalledTimes(4);
    advance(60_000);
    await svc.get("t1");
    expect(fetchNode).toHaveBeenCalledTimes(4);
    advance(5 * 60_000);
    await svc.get("t1");
    expect(fetchNode).toHaveBeenCalledTimes(6);
  });
});

// خريطة الأخطاء بتاعة الفرونت (ملف واحد من غير imports) - بنقراها من هنا بمسار متغير عشان tsc الباك إند مايشيلهاش
describe("WhatsApp connect error help (frontend map)", async () => {
  const file = path.resolve(__dirname, "../../../frontend/src/lib/whatsappConnectHelp.ts");
  const mod: { connectHelp: (e: unknown) => { id: string; switchTo?: string; raw: string }; errorCodes: (s: string) => number[] } = await import(file);

  it("reads error codes from Meta text", () => {
    expect(mod.errorCodes("(#2655111) Partner app lacks required advanced...")).toEqual([2655111]);
    expect(mod.errorCodes("Error code 190, subcode 463")).toEqual([190, 463]);
  });

  it.each([
    ["(#2655111) Partner app lacks required advanced WhatsApp Business management and messaging permissions for onboarding", "partner_access"],
    ["Phone number is already registered on WhatsApp", "number_in_use"],
    ["The Meta window was closed before finishing.", "popup_closed"],
    ["Stopped at “PHONE_NUMBER_SETUP” — press Connect again to continue.", "popup_closed"],
    ["Error validating access token: Session has expired on Monday", "token_expired"],
    [{ message: "Invalid OAuth access token", code: 190 }, "token_expired"],
    ["Meta didn't accept the sign-in: Error validating verification code. Please make sure your redirect_uri is identical", "code_expired"],
    ["(#200) The user does not have permission to manage this business", "wrong_portfolio"],
    ["This WhatsApp account has more than one number — pick it again in the Meta window.", "more_than_one"],
    ["(#131030) Recipient phone number not in allowed list", "not_allowed_list"],
    ["Recipient not on WhatsApp", "recipient_not_on_whatsapp"],
    ["Please update the WhatsApp Business app version to 2.24.17 or newer", "app_version"],
    ["Failed to fetch", "network"],
    ["Connecting with Facebook isn't set up yet — use the manual setup below.", "not_set_up"],
    ["Totally new Meta message", "unknown"],
  ])("%s -> %s", (input, id) => {
    const h = mod.connectHelp(input);
    expect(h.id).toBe(id);
    expect(h.raw.length).toBeGreaterThan(0);
  });

  it("suggests the other path when the number is still on an app", () => {
    expect(mod.connectHelp("number already in use").switchTo).toBe("app");
  });
});
