import type { AccountForPublish, StoredTokens } from "./social.repository";
import type { PublishAccount, PublishContent, PublishResult, RefreshedTokens, SocialPlatform, SocialPublisher } from "./social-types";
import { SocialPlatformError } from "./social-types";
import { decryptToken, encryptToken } from "./token-crypto";

// قبل ما يخلص بـ 5 دقايق بنجدّده
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export interface TokenRefresher {
  refresh(refreshToken: string): Promise<RefreshedTokens>;
}

// توكن متخزن بايظ (اتغيّر مفتاح التشفير مثلًا) = التاجر يربط تاني
function readToken(stored: string): string {
  try {
    return decryptToken(stored);
  } catch {
    throw new SocialPlatformError("This account needs to be connected again.", true);
  }
}

// توكن صالح للحساب: Meta (صفحات) مابيخلصش، تيك توك بيخلص كل 24 ساعة فبنجدّده ونحفظ الجديد
export class SocialTokenService {
  constructor(
    private readonly store: { updateTokens(id: string, tokens: StoredTokens): Promise<void> },
    private readonly refreshers: Partial<Record<SocialPlatform, TokenRefresher>> = {},
    private readonly now: () => Date = () => new Date()
  ) {}

  async accessToken(a: Pick<AccountForPublish, "id" | "platform" | "accessToken" | "tokenExpiresAt" | "refreshToken">): Promise<string> {
    const expiresSoon = a.tokenExpiresAt && a.tokenExpiresAt.getTime() - this.now().getTime() < REFRESH_BEFORE_MS;
    const refresher = this.refreshers[a.platform];
    if (!expiresSoon || !refresher || !a.refreshToken) return readToken(a.accessToken);
    const t = await refresher.refresh(readToken(a.refreshToken));
    await this.store.updateTokens(a.id, {
      accessToken: encryptToken(t.accessToken),
      tokenExpiresAt: t.tokenExpiresAt,
      refreshToken: encryptToken(t.refreshToken),
      refreshExpiresAt: t.refreshExpiresAt,
    });
    return t.accessToken;
  }
}

// كل منصة ليها ناشر - ده بيوزّع البوست على الناشر الصح
export class RoutingPublisher implements SocialPublisher {
  constructor(private readonly byPlatform: Partial<Record<SocialPlatform, SocialPublisher>>) {}

  publish(account: PublishAccount, content: PublishContent): Promise<PublishResult> {
    const p = this.byPlatform[account.platform];
    if (!p) throw new SocialPlatformError(`Publishing to ${account.platform} isn't supported yet`);
    return p.publish(account, content);
  }
}
