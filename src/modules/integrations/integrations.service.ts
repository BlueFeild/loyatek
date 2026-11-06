import crypto from "crypto";
import { NotFoundError, ValidationError } from "../../core/errors";
import { decryptToken, encryptToken } from "../social/token-crypto";
import type { IntegrationsStore, WebhookRow } from "./integrations.repository";
import { WEBHOOK_EVENTS, assertSafeUrl, signatureHeader, type WebhookEvent } from "./webhook-signing";

export const INTEGRATION_LIMITS = {
  maxKeys: 10,
  maxWebhooks: 10,
  timeoutMs: 10_000,
  // محاولات الإرسال لكل حدث (الأولى + إعادتين)
  retryDelaysMs: [30_000, 120_000],
  // كام فشل ورا بعض قبل ما نوقف اللينك
  disableAfter: 20,
} as const;

export const hashApiKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

export type HttpPost = (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ status: number }>;

const realPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs) });
  return { status: res.status };
};

export interface IntegrationsOptions {
  post?: HttpPost;
  now?: () => Date;
  // الإعادة بعد وقت (الاختبارات بتديها دالة فورية)
  later?: (ms: number, fn: () => void) => void;
}

function webhookView(w: WebhookRow) {
  return { id: w.id, url: w.url, events: w.events, enabled: w.enabled, lastStatus: w.lastStatus, lastError: w.lastError, lastDeliveredAt: w.lastDeliveredAt, failCount: w.failCount, createdAt: w.createdAt };
}

// مفاتيح API (للبرامج الخارجية) + Webhooks (نبعت الأحداث للتاجر)
export class IntegrationsService {
  private readonly post: HttpPost;
  private readonly now: () => Date;
  private readonly later: (ms: number, fn: () => void) => void;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly store: IntegrationsStore,
    opts: IntegrationsOptions = {}
  ) {
    this.post = opts.post ?? realPost;
    this.now = opts.now ?? (() => new Date());
    this.later = opts.later ?? ((ms, fn) => void setTimeout(fn, ms).unref?.());
  }

  // ---------- مفاتيح API ----------
  async createKey(tenantId: string, userId: string | null, name: string) {
    if ((await this.store.countKeys(tenantId)) >= INTEGRATION_LIMITS.maxKeys) throw new ValidationError(`You can have up to ${INTEGRATION_LIMITS.maxKeys} API keys — delete one first.`);
    const key = `bf_live_${crypto.randomBytes(24).toString("hex")}`;
    const view = await this.store.createKey({ tenantId, name: name.trim(), prefix: key.slice(0, 14), keyHash: hashApiKey(key), createdById: userId });
    // المفتاح نفسه بيظهر مرة واحدة بس (إحنا بنخزن الـ hash)
    return { ...view, key };
  }

  listKeys(tenantId: string) {
    return this.store.listKeys(tenantId);
  }

  async revokeKey(tenantId: string, id: string) {
    if (!(await this.store.revokeKey(tenantId, id, this.now()))) throw new NotFoundError("API key not found");
    return { ok: true };
  }

  // الطلب الجاي من برّه: المفتاح ← الشركة. null = مفتاح غلط أو اتلغى
  async authenticate(key: string): Promise<{ tenantId: string; keyId: string } | null> {
    if (!/^bf_live_[a-f0-9]{48}$/.test(key)) return null;
    const row = await this.store.keyByHash(hashApiKey(key));
    if (!row || row.revokedAt) return null;
    const now = this.now();
    // آخر استخدام (مرة كل دقيقة بالكتير - مانكتبش في كل طلب)
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) await this.store.touchKey(row.id, now).catch(() => {});
    return { tenantId: row.tenantId, keyId: row.id };
  }

  // ---------- Webhooks ----------
  private checkEvents(events: string[]) {
    const clean = [...new Set(events)];
    if (!clean.length) throw new ValidationError("Choose at least one event.");
    const unknown = clean.find((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (unknown) throw new ValidationError(`Unknown event: ${unknown}`);
    return clean;
  }

  private async checkUrl(url: string) {
    try {
      return (await assertSafeUrl(url.trim())).toString();
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
  }

  async listWebhooks(tenantId: string) {
    return (await this.store.listWebhooks(tenantId)).map(webhookView);
  }

  async createWebhook(tenantId: string, input: { url: string; events: string[] }) {
    if ((await this.store.listWebhooks(tenantId)).length >= INTEGRATION_LIMITS.maxWebhooks) throw new ValidationError(`You can have up to ${INTEGRATION_LIMITS.maxWebhooks} webhooks.`);
    const url = await this.checkUrl(input.url);
    const events = this.checkEvents(input.events);
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
    const row = await this.store.createWebhook({ tenantId, url, events, secret: encryptToken(secret) });
    // الـ secret بيظهر مرة واحدة (التاجر يحطه في السيستم بتاعه عشان يتأكد من التوقيع)
    return { ...webhookView(row), secret };
  }

  async updateWebhook(tenantId: string, id: string, input: { url?: string; events?: string[]; enabled?: boolean }) {
    const patch: { url?: string; events?: string[]; enabled?: boolean } = {};
    if (input.url !== undefined) patch.url = await this.checkUrl(input.url);
    if (input.events !== undefined) patch.events = this.checkEvents(input.events);
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (!(await this.store.updateWebhook(tenantId, id, patch))) throw new NotFoundError("Webhook not found");
    return webhookView((await this.store.webhook(tenantId, id))!);
  }

  async rotateSecret(tenantId: string, id: string) {
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
    if (!(await this.store.updateWebhook(tenantId, id, { secret: encryptToken(secret) }))) throw new NotFoundError("Webhook not found");
    return { secret };
  }

  async deleteWebhook(tenantId: string, id: string) {
    if (!(await this.store.deleteWebhook(tenantId, id))) throw new NotFoundError("Webhook not found");
    return { ok: true };
  }

  // "Send a test": نبعت حدث تجريبي دلوقتي ونرجّع النتيجة على طول
  async testWebhook(tenantId: string, id: string) {
    const w = await this.store.webhook(tenantId, id);
    if (!w) throw new NotFoundError("Webhook not found");
    const r = await this.deliverOnce(w, this.envelope("test", tenantId, { message: "This is a test event from BlueField." }));
    return { ok: r.ok, status: r.status, error: r.error };
  }

  // ---------- إرسال الأحداث ----------
  private envelope(type: string, tenantId: string, data: unknown) {
    return { id: `evt_${crypto.randomBytes(12).toString("hex")}`, type, createdAt: this.now().toISOString(), companyId: tenantId, data };
  }

  // بيتنادى من أي مكان في السيستم - مابيوقفش الطلب الأصلي ولا بيرمي خطأ أبدًا
  emit(tenantId: string, type: WebhookEvent, data: unknown) {
    const work = this.dispatch(tenantId, type, data)
      .catch((err) => console.warn(`[webhooks] ${type} for ${tenantId}: ${(err as Error)?.message}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  // للاختبارات
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async dispatch(tenantId: string, type: WebhookEvent, data: unknown) {
    const subs = await this.store.subscribers(tenantId, type);
    if (!subs.length) return;
    const event = this.envelope(type, tenantId, data);
    await Promise.all(subs.map((w) => this.deliverWithRetry(w, event, 0)));
  }

  private async deliverWithRetry(w: WebhookRow, event: { id: string; type: string }, attempt: number): Promise<void> {
    const r = await this.deliverOnce(w, event);
    const delay = INTEGRATION_LIMITS.retryDelaysMs[attempt];
    // 4xx (غير 408/429) = اللينك رافض الطلب - مفيش فايدة نعيد
    const retryable = !r.ok && (r.status === null || r.status >= 500 || r.status === 408 || r.status === 429);
    if (retryable && delay !== undefined) {
      this.later(delay, () => {
        const work = this.deliverWithRetry(w, event, attempt + 1)
          .catch(() => {})
          .finally(() => this.pending.delete(work));
        this.pending.add(work);
      });
    }
  }

  private async deliverOnce(w: WebhookRow, event: unknown): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const body = JSON.stringify(event);
    const ts = Math.floor(this.now().getTime() / 1000);
    let result: { ok: boolean; status: number | null; error: string | null };
    try {
      await assertSafeUrl(w.url);
      const secret = decryptToken(w.secret);
      const res = await this.post(w.url, {
        headers: { "Content-Type": "application/json", "User-Agent": "BlueField-Webhooks/1.0", "X-BlueField-Event": (event as { type: string }).type, "X-BlueField-Signature": signatureHeader(secret, ts, body) },
        body,
        timeoutMs: INTEGRATION_LIMITS.timeoutMs,
      });
      const ok = res.status >= 200 && res.status < 300;
      result = { ok, status: res.status, error: ok ? null : `The link answered ${res.status}` };
    } catch (err) {
      const e = err as Error;
      result = { ok: false, status: null, error: e.name === "TimeoutError" ? "The link didn't answer within 10 seconds" : e.message || "Couldn't reach the link" };
    }
    await this.store.recordDelivery(w.id, { ...result, at: this.now(), disableAfter: INTEGRATION_LIMITS.disableAfter }).catch(() => {});
    return result;
  }
}
