import { afterEach, describe, expect, it } from "vitest";
import { clientIp, visitorCountry } from "../utils/visitor-country";

const req = (headers: Record<string, string> = {}, remote = "10.0.0.1") => ({ headers, socket: { remoteAddress: remote } }) as never;

describe("visitor country", () => {
  afterEach(() => {
    delete process.env.VISITOR_COUNTRY_OVERRIDE;
  });

  it("reads the real client IP behind the proxy", () => {
    expect(clientIp(req({ "x-real-ip": "37.211.0.9" }))).toBe("37.211.0.9");
    // آخر عنوان = اللي البروكسي ضافه (الأول ممكن الزائر يكتبه بنفسه)
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 41.33.0.5" }))).toBe("41.33.0.5");
    expect(clientIp(req({}, "::ffff:8.8.8.8"))).toBe("8.8.8.8");
  });

  it("override (local tests) wins and is locked — the page's own country is ignored", () => {
    process.env.VISITOR_COUNTRY_OVERRIDE = "qa";
    expect(visitorCountry(req(), "EG")).toEqual({ country: "QA", locked: true });
  });

  it("result is always a valid 2-letter code or null", () => {
    const v = visitorCountry(req(), "zzz");
    expect(v.country === null || /^[A-Z]{2}$/.test(v.country)).toBe(true);
  });
});
