import type { WebhookEvent } from "./webhook-signing";

// نقطة واحدة يبعت منها أي جزء في السيستم حدث للـ webhooks الخارجية، من غير ما يعرف هي بتتبعت إزاي
// (الـ container بيوصّلها بـ IntegrationsService). مابترميش خطأ أبدًا
type Sink = (tenantId: string, type: WebhookEvent, data: unknown) => void;
let sink: Sink | null = null;

export function setEventSink(fn: Sink | null) {
  sink = fn;
}

export function emitEvent(tenantId: string, type: WebhookEvent, data: unknown) {
  try {
    sink?.(tenantId, type, data);
  } catch (err) {
    console.warn(`[webhooks] emit ${type} failed: ${(err as Error)?.message}`);
  }
}
