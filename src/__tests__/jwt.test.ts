import { describe, it, expect, beforeAll } from "vitest";

// لازم نضبط الأسرار قبل ما نستورد jwt.ts، لأنه بيقرأها وقت التحميل
// (module load time) - ولازم NODE_ENV مش "production" عشان requireSecret
// يسمح بقيمة تجريبية بدل ما يرفض التشغيل زي ما هيحصل فعليًا في الإنتاج
beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = "test_access_secret";
  process.env.JWT_REFRESH_SECRET = "test_refresh_secret";
});

describe("JWT access & refresh tokens", () => {
  it("يوقّع ويتحقق من access token حقيقي بنفس البيانات المُدخلة", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../utils/jwt");
    const payload = { userId: "u1", tenantId: "t1", role: "OWNER", branchId: "b1", isSuperAdmin: false };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);

    expect(decoded.userId).toBe("u1");
    expect(decoded.tenantId).toBe("t1");
    expect(decoded.role).toBe("OWNER");
    expect(decoded.isSuperAdmin).toBe(false);
  });

  it("يرفض access token اتوقّع بسر غلط - نموذج محاكاة توكن مزوّر", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ userId: "attacker", tenantId: "victim-tenant", role: "OWNER", isSuperAdmin: true }, "wrong_secret");

    const { verifyAccessToken } = await import("../utils/jwt");
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("refresh token بيحمل userId بس - مش بيانات حساسة زيادة", async () => {
    const { signRefreshToken, verifyRefreshToken } = await import("../utils/jwt");
    const token = signRefreshToken("u42");
    const decoded = verifyRefreshToken(token);
    expect(decoded.userId).toBe("u42");
  });

  it("يرفض refresh token مزوّر بسر غلط", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ userId: "u1" }, "wrong_secret");
    const { verifyRefreshToken } = await import("../utils/jwt");
    expect(() => verifyRefreshToken(forged)).toThrow();
  });
});
