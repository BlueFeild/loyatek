// خدمة "الدخول بالواتساب" - الواجهات اللي الـ service بيعتمد عليها (من غير Prisma ولا Meta)

export type WaLoginSource = "booking" | "site" | "test" | "api";

export interface WaLoginSettingsView {
  enabled: boolean;
  requireOnBooking: boolean;
  siteOrigins: string[];
  templateLang: "en" | "ar";
}

export interface StoredCode {
  id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  usedAt: Date | null;
}

export interface WaLoginStore {
  settings(tenantId: string): Promise<WaLoginSettingsView>;
  saveSettings(tenantId: string, patch: Partial<WaLoginSettingsView>): Promise<WaLoginSettingsView>;
  countCodesSince(tenantId: string, by: { phone?: string; ip?: string }, since: Date): Promise<number>;
  createCode(row: { tenantId: string; phone: string; codeHash: string; expiresAt: Date; ip: string | null; source: WaLoginSource }): Promise<string>;
  deleteCode(id: string): Promise<void>;
  latestOpenCode(tenantId: string, phone: string, now: Date): Promise<StoredCode | null>;
  // بيزوّد المحاولات بشرط إنها لسه أقل من الحد (atomic) - false = خلصت المحاولات
  addAttempt(id: string, max: number): Promise<boolean>;
  // بيعلّم الكود إنه اتستخدم مرة واحدة بس (atomic) - false = اتستخدم قبل كده
  markUsed(id: string, now: Date): Promise<boolean>;
  usage(tenantId: string, since: Date): Promise<{ sent: number; verified: number }>;
}

// بيبعت الكود للعميل (قالب AUTHENTICATION معتمد على رقم واتساب التاجر)
export interface OtpSender {
  send(tenantId: string, phone: string, code: string, lang: "en" | "ar"): Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
}

export const WA_LOGIN_LIMITS = {
  codeLength: 6,
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
  // نفس الرقم: 3 أكواد كل 10 دقايق، ونفس الجهاز (IP): 10 كل 10 دقايق
  perPhone: 3,
  perIp: 10,
  windowMs: 10 * 60 * 1000,
  tokenDays: 30,
} as const;
