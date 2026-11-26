import { CarrierError, type CarrierCode, type FetchLike } from "./shipping.types";

// كلام HTTP المشترك لكل شركات الشحن: مهلة (8 ثواني افتراضي)، JSON، وتحويل الأخطاء لـ CarrierError واضح.
export const CARRIER_TIMEOUT_MS = Number(process.env.SHIPPING_CARRIER_TIMEOUT_MS) || 8000;

export interface HttpResult {
  status: number;
  ok: boolean;
  json: any;
  text: string;
}

export async function carrierRequest(
  carrier: CarrierCode,
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs = CARRIER_TIMEOUT_MS
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401 || res.status === 403) throw new CarrierError("auth", "The carrier refused the account details. Check the keys and the test/live switch.", carrier);
    if (res.status === 429 || res.status >= 500) throw new CarrierError("unavailable", `The carrier isn't answering right now (${res.status}). Please try again in a few minutes.`, carrier);
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    if (e instanceof CarrierError) throw e;
    const aborted = (e as Error)?.name === "AbortError";
    throw new CarrierError("unavailable", aborted ? "The carrier took too long to answer." : "Couldn't reach the carrier.", carrier);
  } finally {
    clearTimeout(timer);
  }
}

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export const trimBase = (u: string) => u.replace(/\/+$/, "");
export const round2 = (n: number) => Math.round(n * 100) / 100;
// رقم الهاتف من غير رموز (الشركات بتقبل أرقام + بس)
export const digitsPhone = (p: string) => {
  const d = (p || "").replace(/[^\d+]/g, "");
  return d.startsWith("+") ? d : d ? `+${d}` : "";
};
