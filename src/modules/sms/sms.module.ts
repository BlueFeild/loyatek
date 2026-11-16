import { PrismaSmsStore } from "./sms.repository";
import { providerFromEnv, type SmsProvider } from "./sms-provider";
import { SmsService } from "./sms.service";

// توصيل خدمة الـ SMS (نفس فكرة core/container.ts): المزوّد بيتحدد مرة واحدة من الـ env
let cached: SmsProvider | null | undefined;
export function smsProvider(): SmsProvider | null {
  if (cached === undefined) cached = providerFromEnv();
  return cached;
}

export const smsService = new SmsService(new PrismaSmsStore(), smsProvider);
