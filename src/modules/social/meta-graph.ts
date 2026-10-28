import { graphBase } from "../whatsapp/whatsapp.service";
import { SocialPlatformError } from "./social-types";

// طلب واحد لـ Graph API بتاع Meta (النشر + الصندوق + الإعلانات بيستخدموه).
// META_GRAPH_BASE_URL = Meta وهمية للتجارب المحلية بس
const FETCH_TIMEOUT_MS = 60_000;

type GraphJson = { error?: { message?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string } } & Record<string, any>;

export interface GraphRequest {
  token?: string;
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
}

export async function metaGraph(path: string, opts: GraphRequest = {}): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(`${graphBase()}${path}`, {
      method: opts.method ?? "GET",
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SocialPlatformError(`Couldn't reach Meta: ${(err as Error).message}`);
  }
  const data = ((await res.json().catch(() => ({}))) ?? {}) as GraphJson;
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    // 190 = التوكن انتهى أو اتلغى (التاجر غيّر الباسورد / شال صلاحية التطبيق)
    const reconnect = e.code === 190 || e.code === 102 || e.error_subcode === 463 || e.error_subcode === 460;
    throw new SocialPlatformError(e.error_user_msg || e.message || `Meta error ${res.status}`, reconnect, e.code);
  }
  return data;
}
