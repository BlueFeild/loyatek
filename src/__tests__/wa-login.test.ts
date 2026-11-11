import { describe, expect, it, beforeEach } from "vitest";
import { WaLoginService } from "../modules/wa-login/wa-login.service";
import type { OtpSender, StoredCode, WaLoginSettingsView, WaLoginSource, WaLoginStore } from "../modules/wa-login/wa-login.types";

class MemStore implements WaLoginStore {
  s: WaLoginSettingsView = { enabled: true, requireOnBooking: false, siteOrigins: [], templateLang: "en" };
  rows: (StoredCode & { tenantId: string; phone: string; ip: string | null; createdAt: Date })[] = [];
  n = 0;
  constructor(private clock: () => Date) {}
  async settings() { return this.s; }
  async saveSettings(_t: string, p: Partial<WaLoginSettingsView>) { this.s = { ...this.s, ...p }; return this.s; }
  async countCodesSince(tenantId: string, by: { phone?: string; ip?: string }, since: Date) {
    return this.rows.filter((r) => r.tenantId === tenantId && r.createdAt >= since && (!by.phone || r.phone === by.phone) && (!by.ip || r.ip === by.ip)).length;
  }
  async createCode(row: { tenantId: string; phone: string; codeHash: string; expiresAt: Date; ip: string | null; source: WaLoginSource }) {
    const id = "c" + ++this.n;
    this.rows.push({ id, tenantId: row.tenantId, phone: row.phone, codeHash: row.codeHash, expiresAt: row.expiresAt, attempts: 0, usedAt: null, ip: row.ip, createdAt: this.clock() });
    return id;
  }
  async deleteCode(id: string) { this.rows = this.rows.filter((r) => r.id !== id); }
  async latestOpenCode(tenantId: string, phone: string, now: Date) {
    return [...this.rows].reverse().find((r) => r.tenantId === tenantId && r.phone === phone && !r.usedAt && r.expiresAt > now) ?? null;
  }
  async addAttempt(id: string, max: number) { const r = this.rows.find((x) => x.id === id)!; if (r.attempts >= max) return false; r.attempts++; return true; }
  async markUsed(id: string, now: Date) { const r = this.rows.find((x) => x.id === id)!; if (r.usedAt) return false; r.usedAt = now; return true; }
  async usage() { return { sent: this.rows.length, verified: this.rows.filter((r) => r.usedAt).length }; }
}

class FakeSender implements OtpSender {
  last: { phone: string; code: string } | null = null;
  fail = false;
  async send(_t: string, phone: string, code: string) {
    if (this.fail) return { ok: false as const, error: "Meta said no" };
    this.last = { phone, code };
    return { ok: true as const };
  }
}

describe("WhatsApp login", () => {
  let now = new Date("2026-11-11T10:00:00Z");
  const clock = () => now;
  let store: MemStore, sender: FakeSender, svc: WaLoginService;
  beforeEach(() => {
    now = new Date("2026-11-11T10:00:00Z");
    store = new MemStore(clock);
    sender = new FakeSender();
    svc = new WaLoginService(store, sender, () => "test-secret", clock);
  });

  it("sends a 6-digit code and stores only its hash", async () => {
    await svc.start({ tenantId: "t1", phone: "+974 5555 1234", ip: "1.1.1.1", source: "site" });
    expect(sender.last?.phone).toBe("97455551234");
    expect(sender.last?.code).toMatch(/^\d{6}$/);
    expect(store.rows[0].codeHash).not.toContain(sender.last!.code);
  });

  it("verifies the right code once and gives a token for that business only", async () => {
    await svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "site" });
    const { token, phone } = await svc.verify({ tenantId: "t1", phone: "+974 5555 1234", code: sender.last!.code });
    expect(phone).toBe("97455551234");
    expect(svc.readToken("t1", token)).toBe("97455551234");
    expect(svc.readToken("t2", token)).toBeNull();
    await expect(svc.verify({ tenantId: "t1", phone: "97455551234", code: sender.last!.code })).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("refuses a wrong code and locks after 5 tries", async () => {
    await svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "site" });
    const wrong = sender.last!.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(svc.verify({ tenantId: "t1", phone: "97455551234", code: wrong })).rejects.toMatchObject({ code: "WRONG_CODE" });
    await expect(svc.verify({ tenantId: "t1", phone: "97455551234", code: sender.last!.code })).rejects.toMatchObject({ code: "TOO_MANY_TRIES" });
  });

  it("codes expire after 5 minutes", async () => {
    await svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "site" });
    now = new Date(now.getTime() + 6 * 60 * 1000);
    await expect(svc.verify({ tenantId: "t1", phone: "97455551234", code: sender.last!.code })).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("limits codes per number and per device", async () => {
    for (let i = 0; i < 3; i++) await svc.start({ tenantId: "t1", phone: "97455551234", ip: "9.9.9.9", source: "site" });
    await expect(svc.start({ tenantId: "t1", phone: "97455551234", ip: "8.8.8.8", source: "site" })).rejects.toMatchObject({ code: "TOO_MANY_CODES" });
    for (let i = 0; i < 7; i++) await svc.start({ tenantId: "t1", phone: "9745555000" + i, ip: "9.9.9.9", source: "site" });
    await expect(svc.start({ tenantId: "t1", phone: "97455559999", ip: "9.9.9.9", source: "site" })).rejects.toMatchObject({ code: "TOO_MANY_CODES" });
  });

  it("a code that WhatsApp couldn't deliver doesn't count", async () => {
    sender.fail = true;
    await expect(svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "site" })).rejects.toMatchObject({ status: 502 });
    expect(store.rows).toHaveLength(0);
  });

  it("is refused when the merchant switched it off (except a test code)", async () => {
    store.s.enabled = false;
    await expect(svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "site" })).rejects.toMatchObject({ code: "WA_LOGIN_OFF" });
    await expect(svc.start({ tenantId: "t1", phone: "97455551234", ip: null, source: "test" })).resolves.toBeTruthy();
  });

  it("checks numbers loosely (with or without country code) and rejects junk", () => {
    expect(WaLoginService.samePhone("97455551234", "+974 5555 1234")).toBe(true);
    expect(WaLoginService.samePhone("97455551234", "55551234")).toBe(true);
    expect(WaLoginService.samePhone("97455551234", "97455551235")).toBe(false);
    expect(() => WaLoginService.normalizePhone("123")).toThrow();
  });
});
