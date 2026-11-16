// مزوّد الـ SMS: المنصة عندها حساب واحد عند مزوّد (المفاتيح في Railway Variables بس)
// وبتبيع الرسايل للشركات. الخدمة مابتعرفش هو مين - بتكلّم الواجهة دي بس
export interface SmsSendInput {
  to: string; // أرقام بس مع كود الدولة
  body: string;
  sender?: string | null;
}
export interface SmsSendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
}
export interface SmsProvider {
  readonly name: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

const TIMEOUT_MS = 15_000;

function shortError(text: string): string {
  return String(text || "").replace(/\s+/g, " ").slice(0, 200);
}

// Twilio: POST /2010-04-01/Accounts/{sid}/Messages.json (form) بـ Basic auth
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  constructor(
    private readonly cfg: { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string; baseUrl?: string }
  ) {}

  async send({ to, body, sender }: SmsSendInput): Promise<SmsSendResult> {
    const base = (this.cfg.baseUrl || "https://api.twilio.com").replace(/\/$/, "");
    const form = new URLSearchParams({ To: `+${to}`, Body: body });
    if (this.cfg.messagingServiceSid) form.set("MessagingServiceSid", this.cfg.messagingServiceSid);
    else form.set("From", sender || this.cfg.from || "");
    try {
      const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
      if (!res.ok || data.status === "failed" || data.status === "undelivered") {
        return { ok: false, error: shortError(data.message || `Twilio error ${res.status}${data.code ? ` (${data.code})` : ""}`) };
      }
      return { ok: true, providerId: data.sid };
    } catch (err) {
      return { ok: false, error: shortError(`Couldn't reach Twilio: ${(err as Error).message}`) };
    }
  }
}

// Infobip: POST {base}/sms/2/text/advanced بهيدر "App <key>"
export class InfobipSmsProvider implements SmsProvider {
  readonly name = "infobip";
  constructor(private readonly cfg: { baseUrl: string; apiKey: string; from?: string }) {}

  async send({ to, body, sender }: SmsSendInput): Promise<SmsSendResult> {
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    const url = /^https?:\/\//.test(base) ? base : `https://${base}`;
    const message: Record<string, unknown> = { destinations: [{ to }], text: body };
    const from = sender || this.cfg.from;
    if (from) message.from = from;
    try {
      const res = await fetch(`${url}/sms/2/text/advanced`, {
        method: "POST",
        headers: { Authorization: `App ${this.cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ messages: [message] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as {
        messages?: { messageId?: string; status?: { groupName?: string; description?: string } }[];
        requestError?: { serviceException?: { text?: string } };
      };
      const m = data.messages?.[0];
      if (!res.ok || !m) return { ok: false, error: shortError(data.requestError?.serviceException?.text || `Infobip error ${res.status}`) };
      if (m.status?.groupName === "REJECTED" || m.status?.groupName === "UNDELIVERABLE") {
        return { ok: false, error: shortError(m.status.description || m.status.groupName) };
      }
      return { ok: true, providerId: m.messageId };
    } catch (err) {
      return { ok: false, error: shortError(`Couldn't reach Infobip: ${(err as Error).message}`) };
    }
  }
}

// للتجارب المحلية بس (SMS_PROVIDER=fake): بيسجّل الرسايل في الذاكرة.
// SMS_FAKE_FAIL_NUMBERS="9745...,9746..." = الأرقام دي بتفشل (عشان نجرّب الاسترجاع)
export class FakeSmsProvider implements SmsProvider {
  readonly name = "fake";
  readonly sent: SmsSendInput[] = [];
  private readonly failing: Set<string>;
  constructor(failNumbers: string[] = []) {
    this.failing = new Set(failNumbers.map((n) => n.replace(/\D/g, "")).filter(Boolean));
  }
  failNumber(phone: string) {
    this.failing.add(phone.replace(/\D/g, ""));
  }
  async send(input: SmsSendInput): Promise<SmsSendResult> {
    if (this.failing.has(input.to)) return { ok: false, error: "Fake provider: this number was set to fail" };
    this.sent.push(input);
    return { ok: true, providerId: `fake-${this.sent.length}-${Date.now().toString(36)}` };
  }
}

// اختيار المزوّد من الـ env: SMS_PROVIDER=twilio|infobip|fake. ناقص مفاتيح = null (الخدمة مش شغالة)
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SmsProvider | null {
  const kind = (env.SMS_PROVIDER || "").trim().toLowerCase();
  if (kind === "fake") return new FakeSmsProvider((env.SMS_FAKE_FAIL_NUMBERS || "").split(","));
  if (kind === "twilio") {
    const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = env.TWILIO_AUTH_TOKEN?.trim();
    const from = env.TWILIO_FROM?.trim();
    const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    if (!accountSid || !authToken || (!from && !messagingServiceSid)) return null;
    return new TwilioSmsProvider({ accountSid, authToken, from, messagingServiceSid, baseUrl: env.TWILIO_BASE_URL?.trim() });
  }
  if (kind === "infobip") {
    const baseUrl = env.INFOBIP_BASE_URL?.trim();
    const apiKey = env.INFOBIP_API_KEY?.trim();
    if (!baseUrl || !apiKey) return null;
    return new InfobipSmsProvider({ baseUrl, apiKey, from: env.INFOBIP_FROM?.trim() });
  }
  return null;
}
