import type { PrismaClient } from "@prisma/client";
import type { StoredCode, WaLoginSettingsView, WaLoginSource, WaLoginStore } from "./wa-login.types";

// Prisma بس - مفيش منطق هنا
export class PrismaWaLoginStore implements WaLoginStore {
  constructor(private readonly db: PrismaClient) {}

  private view(row: { enabled: boolean; requireOnBooking: boolean; siteOrigins: string[]; templateLang: string } | null): WaLoginSettingsView {
    return {
      enabled: row?.enabled ?? false,
      requireOnBooking: row?.requireOnBooking ?? false,
      siteOrigins: row?.siteOrigins ?? [],
      templateLang: row?.templateLang === "ar" ? "ar" : "en",
    };
  }

  async settings(tenantId: string) {
    return this.view(await this.db.waLoginSettings.findUnique({ where: { tenantId } }));
  }

  async saveSettings(tenantId: string, patch: Partial<WaLoginSettingsView>) {
    const row = await this.db.waLoginSettings.upsert({ where: { tenantId }, create: { tenantId, ...patch }, update: patch });
    return this.view(row);
  }

  countCodesSince(tenantId: string, by: { phone?: string; ip?: string }, since: Date) {
    return this.db.waLoginCode.count({ where: { tenantId, createdAt: { gte: since }, ...(by.phone ? { phone: by.phone } : {}), ...(by.ip ? { ip: by.ip } : {}) } });
  }

  async createCode(row: { tenantId: string; phone: string; codeHash: string; expiresAt: Date; ip: string | null; source: WaLoginSource }) {
    return (await this.db.waLoginCode.create({ data: row, select: { id: true } })).id;
  }

  async deleteCode(id: string) {
    await this.db.waLoginCode.delete({ where: { id } }).catch(() => {});
  }

  latestOpenCode(tenantId: string, phone: string, now: Date): Promise<StoredCode | null> {
    return this.db.waLoginCode.findFirst({
      where: { tenantId, phone, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, codeHash: true, expiresAt: true, attempts: true, usedAt: true },
    });
  }

  async addAttempt(id: string, max: number) {
    const r = await this.db.waLoginCode.updateMany({ where: { id, attempts: { lt: max } }, data: { attempts: { increment: 1 } } });
    return r.count === 1;
  }

  async markUsed(id: string, now: Date) {
    const r = await this.db.waLoginCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: now } });
    return r.count === 1;
  }

  async usage(tenantId: string, since: Date) {
    const [sent, verified] = await Promise.all([
      this.db.waLoginCode.count({ where: { tenantId, createdAt: { gte: since }, source: { not: "test" } } }),
      this.db.waLoginCode.count({ where: { tenantId, createdAt: { gte: since }, usedAt: { not: null }, source: { not: "test" } } }),
    ]);
    return { sent, verified };
  }
}
