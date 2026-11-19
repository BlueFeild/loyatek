import { graphBase } from "./whatsapp.service";

// "صحة حساب الواتساب": بنسأل Meta عن الرقم وحساب البيزنس (WABA) ونترجم الرد لكلام بسيط
// للتاجر (الاسم اتوافق عليه؟ الجودة؟ كام محادثة جديدة في اليوم؟ رقم تجربة؟).
// - التوكن = توكن الشركة نفسها (مش بيرجع للفرونت أبدًا)
// - أي حقل Meta ترفضه بيتشال بس (مش بيوقع الكارت كله)
// - الرد بيتخزن 5 دقايق لكل شركة
// المنطق نفسه (parse/build) pure عشان يتختبر من غير Meta

export const PHONE_FIELDS = [
  "display_phone_number",
  "verified_name",
  "name_status",
  "new_name_status",
  "quality_rating",
  "messaging_limit_tier",
  "code_verification_status",
  "platform_type",
  "throughput",
  "is_on_biz_app",
  "status",
  "account_mode",
] as const;

export const WABA_FIELDS = ["name", "business_verification_status", "owner_business_info", "account_review_status", "primary_funding_id"] as const;

export type RawFields = Record<string, unknown>;

// نتيجة سؤال Meta: الحقول اللي رجعت + هل التوكن نفسه بايظ
export interface FetchResult {
  data: RawFields;
  failedFields: string[];
  tokenProblem?: string; // 190 وأخواته = لازم يتربط تاني
  error?: string; // Meta مش بترد خالص
}

export interface AccountHealthGateway {
  fetchNode(token: string, nodeId: string, fields: readonly string[]): Promise<FetchResult>;
}

export type NameStatus = "approved" | "pending" | "declined" | "none" | "unknown";
export type Quality = "green" | "yellow" | "red" | "unknown";
export type Verification = "verified" | "pending" | "not_verified" | "rejected" | "unknown";

export interface AccountHealth {
  connected: true;
  checkedAt: string;
  cached: boolean;
  reconnect: string | null; // التوكن انتهى/اتلغى -> لازم يتربط من جديد
  unreachable: string | null; // Meta مش بترد دلوقتي
  number: {
    display: string | null;
    verifiedName: string | null;
    nameStatus: NameStatus | null;
    nameStatusRaw: string | null;
    pendingNewName: boolean; // في اسم جديد مستني موافقة
    quality: Quality | null;
    dailyLimit: number | null; // كام محادثة جديدة يبدأها في اليوم (null = مش معروف)
    unlimited: boolean;
    tierRaw: string | null;
    codeVerified: boolean | null;
    platform: string | null;
    throughput: string | null;
    onBusinessApp: boolean | null; // Coexistence: الرقم لسه على تطبيق WhatsApp Business
    isTestNumber: boolean;
    sandbox: boolean;
    status: string | null;
  };
  business: {
    name: string | null;
    ownerName: string | null;
    ownerId: string | null;
    verification: Verification | null;
    verificationRaw: string | null;
    reviewStatus: string | null;
    hasPaymentMethod: boolean | null;
  };
  links: { securityCenter: string; payment: string; whatsappManager: string };
  missingFields: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// أرقام التجربة اللي Meta بتديها للمطورين بتبدأ بـ +1 555 (كانت سبب لخبطة: افتكرناه رقم العميل)
export function isMetaTestNumber(display: string | null | undefined): boolean {
  if (!display) return false;
  const digits = display.replace(/\D/g, "");
  return /^1555\d{7}$/.test(digits);
}

export function parseNameStatus(raw: string | null): NameStatus | null {
  if (!raw) return null;
  const v = raw.toUpperCase();
  if (v === "APPROVED" || v === "AVAILABLE_WITHOUT_REVIEW") return "approved";
  if (v === "PENDING_REVIEW" || v === "PENDING" || v === "IN_REVIEW") return "pending";
  if (v === "DECLINED" || v === "REJECTED" || v === "EXPIRED") return "declined";
  if (v === "NONE" || v === "NON_EXISTS") return "none";
  return "unknown";
}

export function parseQuality(raw: string | null): Quality | null {
  if (!raw) return null;
  const v = raw.toUpperCase();
  if (v === "GREEN" || v === "HIGH") return "green";
  if (v === "YELLOW" || v === "MEDIUM") return "yellow";
  if (v === "RED" || v === "LOW") return "red";
  return "unknown";
}

// TIER_250 = 250 محادثة جديدة في اليوم (قبل توثيق البيزنس)، TIER_1K = 1000 ... TIER_UNLIMITED
export function parseTier(raw: string | null): { dailyLimit: number | null; unlimited: boolean } {
  if (!raw) return { dailyLimit: null, unlimited: false };
  const v = raw.toUpperCase();
  if (v.includes("UNLIMITED")) return { dailyLimit: null, unlimited: true };
  const m = /^TIER_(\d+)(K?)$/.exec(v);
  if (!m) return { dailyLimit: null, unlimited: false };
  return { dailyLimit: Number(m[1]) * (m[2] ? 1000 : 1), unlimited: false };
}

export function parseVerification(raw: string | null): Verification | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === "verified") return "verified";
  if (v.includes("pending") || v === "in_review") return "pending";
  if (v === "rejected" || v === "failed" || v === "revoked") return "rejected";
  if (v.startsWith("not_verified") || v === "unverified" || v === "not_started") return "not_verified";
  return "unknown";
}

export function buildAccountHealth(
  phone: FetchResult,
  waba: FetchResult | null,
  opts: { now: Date; fallbackDisplay?: string | null; fallbackName?: string | null }
): AccountHealth {
  const p = phone.data;
  const w = waba?.data ?? {};
  const display = str(p.display_phone_number) ?? opts.fallbackDisplay ?? null;
  const nameStatusRaw = str(p.name_status);
  const newName = str(p.new_name_status);
  const tierRaw = str(p.messaging_limit_tier);
  const tier = parseTier(tierRaw);
  const code = str(p.code_verification_status);
  const throughput = p.throughput && typeof p.throughput === "object" ? str((p.throughput as Record<string, unknown>).level) : str(p.throughput);
  const owner = w.owner_business_info && typeof w.owner_business_info === "object" ? (w.owner_business_info as Record<string, unknown>) : null;
  const ownerId = owner ? str(owner.id) ?? (typeof owner.id === "number" ? String(owner.id) : null) : null;
  const verificationRaw = str(w.business_verification_status);
  const q = ownerId ? `?business_id=${encodeURIComponent(ownerId)}` : "";
  const reconnect = phone.tokenProblem ?? waba?.tokenProblem ?? null;
  return {
    connected: true,
    checkedAt: opts.now.toISOString(),
    cached: false,
    reconnect,
    unreachable: !reconnect && phone.error ? phone.error : null,
    number: {
      display,
      verifiedName: str(p.verified_name) ?? opts.fallbackName ?? null,
      nameStatus: parseNameStatus(nameStatusRaw),
      nameStatusRaw,
      pendingNewName: Boolean(newName && parseNameStatus(newName) === "pending"),
      quality: parseQuality(str(p.quality_rating)),
      dailyLimit: tier.dailyLimit,
      unlimited: tier.unlimited,
      tierRaw,
      codeVerified: code ? code.toUpperCase() === "VERIFIED" : null,
      platform: str(p.platform_type),
      throughput,
      onBusinessApp: typeof p.is_on_biz_app === "boolean" ? p.is_on_biz_app : null,
      isTestNumber: isMetaTestNumber(display),
      sandbox: str(p.account_mode)?.toUpperCase() === "SANDBOX",
      status: str(p.status),
    },
    business: {
      name: str(w.name),
      ownerName: owner ? str(owner.name) : null,
      ownerId,
      verification: parseVerification(verificationRaw),
      verificationRaw,
      reviewStatus: str(w.account_review_status),
      // الحقل ده بيرجع بس لو في وسيلة دفع (لو Meta ماردّتش عليه أصلاً = مش معروف)
      hasPaymentMethod: !reconnect && waba && !waba.failedFields.includes("primary_funding_id") && !waba.error ? Boolean(str(w.primary_funding_id) ?? (typeof w.primary_funding_id === "number" ? "x" : null)) : null,
    },
    links: {
      securityCenter: `https://business.facebook.com/settings/security${q}`,
      payment: `https://business.facebook.com/billing_hub/payment_settings${q}`,
      whatsappManager: `https://business.facebook.com/wa/manage/phone-numbers/${q}`,
    },
    missingFields: [...phone.failedFields, ...(waba?.failedFields ?? [])],
  };
}

// ---------------- Meta (Graph API) ----------------

type GraphError = { message?: string; code?: number; error_subcode?: number };

function isTokenError(e: GraphError | undefined): boolean {
  return Boolean(e && (e.code === 190 || e.code === 102 || e.error_subcode === 463 || e.error_subcode === 460));
}

const TIMEOUT_MS = 15_000;

export class MetaAccountHealthGateway implements AccountHealthGateway {
  private async get(token: string, path: string): Promise<{ ok: boolean; data: RawFields; error?: GraphError; network?: string }> {
    try {
      const res = await fetch(`${graphBase()}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = ((await res.json().catch(() => ({}))) ?? {}) as RawFields & { error?: GraphError };
      if (!res.ok || data.error) return { ok: false, data: {}, error: data.error ?? { message: `Meta error ${res.status}` } };
      return { ok: true, data };
    } catch (err) {
      return { ok: false, data: {}, network: (err as Error).message };
    }
  }

  // نطلب كل الحقول مرة واحدة؛ لو Meta رفضت (حقل مش موجود في النسخة دي مثلاً) نطلب كل حقل لوحده
  async fetchNode(token: string, nodeId: string, fields: readonly string[]): Promise<FetchResult> {
    const all = await this.get(token, `/${encodeURIComponent(nodeId)}?fields=${fields.join(",")}`);
    if (all.ok) return { data: all.data, failedFields: [] };
    if (all.network) return { data: {}, failedFields: [...fields], error: `Couldn't reach Meta: ${all.network}` };
    if (isTokenError(all.error)) return { data: {}, failedFields: [...fields], tokenProblem: all.error?.message ?? "The connection to Meta expired" };
    const parts = await Promise.all(fields.map(async (f) => ({ f, r: await this.get(token, `/${encodeURIComponent(nodeId)}?fields=${f}`) })));
    const data: RawFields = {};
    const failed: string[] = [];
    for (const { f, r } of parts) {
      if (r.ok) {
        if (f in r.data) data[f] = r.data[f];
      } else failed.push(f);
    }
    const token190 = parts.find((x) => isTokenError(x.r.error));
    if (token190) return { data, failedFields: failed, tokenProblem: token190.r.error?.message ?? "The connection to Meta expired" };
    if (failed.length === fields.length) return { data, failedFields: failed, error: all.error?.message ?? "Meta didn't answer" };
    return { data, failedFields: failed };
  }
}

// ---------------- Service ----------------

export interface HealthSettingsSource {
  connection(tenantId: string): Promise<{ isConnected: boolean; token: string | null; phoneNumberId: string | null; wabaId: string | null; display: string | null; name: string | null } | null>;
}

export const HEALTH_CACHE_MS = 5 * 60_000;
export const HEALTH_MIN_REFRESH_MS = 20_000;

export class AccountHealthService {
  private cache = new Map<string, { key: string; at: number; value: AccountHealth }>();

  constructor(
    private readonly settings: HealthSettingsSource,
    private readonly gateway: AccountHealthGateway,
    private readonly now: () => Date = () => new Date()
  ) {}

  async get(tenantId: string, opts: { refresh?: boolean } = {}): Promise<AccountHealth | { connected: false }> {
    const s = await this.settings.connection(tenantId);
    if (!s?.isConnected || !s.token || !s.phoneNumberId) {
      this.cache.delete(tenantId);
      return { connected: false };
    }
    const key = `${s.phoneNumberId}|${s.wabaId ?? ""}|${s.token.slice(-12)}`;
    const t = this.now().getTime();
    const hit = this.cache.get(tenantId);
    if (hit && hit.key === key) {
      const age = t - hit.at;
      // "Check again" مسموح بس بعد 20 ثانية (عشان مانزعجش Meta)
      if (age < HEALTH_CACHE_MS && (!opts.refresh || age < HEALTH_MIN_REFRESH_MS)) return { ...hit.value, cached: true };
    }
    const [phone, waba] = await Promise.all([
      this.gateway.fetchNode(s.token, s.phoneNumberId, PHONE_FIELDS),
      s.wabaId ? this.gateway.fetchNode(s.token, s.wabaId, WABA_FIELDS) : Promise.resolve(null),
    ]);
    const value = buildAccountHealth(phone, waba, { now: this.now(), fallbackDisplay: s.display, fallbackName: s.name });
    // Meta مش بترد = مانخزنش (المرة الجاية نحاول تاني)
    if (!value.unreachable) this.cache.set(tenantId, { key, at: t, value });
    return value;
  }
}
