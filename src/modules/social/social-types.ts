import { AppError } from "../../core/errors";

// النشر على السوشيال ميديا: العقود اللي الخدمات بتعتمد عليها (مش على Meta نفسها).
// كل منصة = class بينفّذ SocialPublisher، ونسخة وهمية للاختبارات

export const SOCIAL_PLATFORMS = ["FACEBOOK", "INSTAGRAM", "TIKTOK", "SNAPCHAT"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_LIMITS = {
  captionMax: 5000,
  // حد انستجرام للكابشن
  instagramCaptionMax: 2200,
  imageMaxBytes: 8 * 1024 * 1024,
  videoMaxBytes: 100 * 1024 * 1024,
  // أقصى ميعاد للجدولة
  scheduleMaxDays: 90,
  // بوست فضل PUBLISHING أكتر من كده (السيرفر اتعاد تشغيله) = اتقطع
  staleAfterMs: 20 * 60 * 1000,
} as const;

export const SOCIAL_MEDIA_TYPES: Record<string, "image" | "video"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
};

// حساب جاي من المنصة وقت الربط (قبل ما يتحفظ)
export interface DiscoveredAccount {
  platform: SocialPlatform;
  externalId: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  parentId: string | null;
  accessToken: string;
  tokenExpiresAt: Date | null;
}

// ربط Meta: الكود اللي رجع من نافذة فيسبوك → صفحات + حسابات انستجرام
export interface MetaAccountConnector {
  discoverAccounts(login: { code: string } | { accessToken: string }): Promise<DiscoveredAccount[]>;
}

export interface PublishAccount {
  platform: SocialPlatform;
  externalId: string;
  accessToken: string;
}

export interface PublishContent {
  caption: string;
  media: { kind: "image" | "video"; url: string } | null;
}

export interface PublishResult {
  externalPostId: string;
  permalink: string | null;
}

export interface SocialPublisher {
  publish(account: PublishAccount, content: PublishContent): Promise<PublishResult>;
}

// خطأ من المنصة. needsReconnect = التوكن مابقاش شغال (التاجر يربط تاني)
export class SocialPlatformError extends AppError {
  constructor(
    message: string,
    public readonly needsReconnect = false
  ) {
    super(502, "SOCIAL_PLATFORM_ERROR", message);
  }
}
