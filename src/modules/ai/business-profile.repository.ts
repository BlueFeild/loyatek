import { PrismaClient } from "@prisma/client";
import type { BusinessContext } from "./copy-generator";

// بيانات الشركة اللي الذكاء الاصطناعي بيكتب/يصمم عنها (الاسم + المجال)
export interface BusinessProfileReader {
  business(tenantId: string): Promise<BusinessContext | null>;
}

// الوصول لقاعدة البيانات بس
export class PrismaBusinessProfileReader implements BusinessProfileReader {
  constructor(private readonly db: PrismaClient) {}

  async business(tenantId: string): Promise<BusinessContext | null> {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, industry: true } });
    return t ? { name: t.name, industry: String(t.industry) } : null;
  }
}
