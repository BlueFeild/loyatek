import { metaGraph } from "./meta-graph";
import { SocialPlatformError } from "./social-types";
import type { AdAccountInfo, AdCity, AdInsights, AdsPlatform, AdState, AdTargeting, BoostIds, BoostSpec } from "./ads-types";

// تمويل بوست عند Meta (Marketing API): حملة → مجموعة إعلانية (الميزانية + الجمهور + المدة) → شكل الإعلان (البوست نفسه) → إعلان.
// كل حاجة بتتعمل والحملة "متوقفة"، وبعد ما كله ينجح بنشغّلها. لو خطوة فشلت بنمسح الحملة (اللي جواها بيتمسح معاها)

const ACCOUNT_STATUS: Record<number, string> = {
  1: "Active",
  2: "Disabled",
  3: "Unpaid balance — settle it in Meta Ads Manager",
  7: "Under review by Meta",
  8: "Pending settlement",
  9: "In grace period",
  100: "Pending closure",
  101: "Closed",
};

// اللي بنعرضه للتاجر يتعمل ابتداءً من الهدف
const GOALS = {
  REACH: { objective: "OUTCOME_AWARENESS", optimization: "REACH" },
  ENGAGEMENT: { objective: "OUTCOME_ENGAGEMENT", optimization: "POST_ENGAGEMENT" },
} as const;

function targetingFor(t: AdTargeting, platform: BoostSpec["platform"]) {
  const geo: Record<string, unknown> = {};
  if (t.cities.length > 0) geo.cities = t.cities.map((c) => ({ key: c.key }));
  else geo.countries = t.countries;
  return {
    geo_locations: geo,
    age_min: t.ageMin,
    age_max: t.ageMax,
    ...(t.gender === "men" ? { genders: [1] } : t.gender === "women" ? { genders: [2] } : {}),
    publisher_platforms: [platform === "INSTAGRAM" ? "instagram" : "facebook"],
    // الجمهور اللي التاجر اختاره بالظبط (من غير ما Meta توسّعه لوحدها)
    targeting_automation: { advantage_audience: 0 },
  };
}

export class MetaAdsGateway implements AdsPlatform {
  async listAdAccounts(userToken: string): Promise<AdAccountInfo[]> {
    const fields = "id,name,currency,account_status";
    const r = await metaGraph(`/me/adaccounts?fields=${fields}&limit=50`, { token: userToken });
    return (Array.isArray(r.data) ? r.data : [])
      .filter((a: any) => typeof a?.id === "string")
      .map((a: any) => ({
        id: String(a.id).startsWith("act_") ? String(a.id) : `act_${a.id}`,
        name: String(a.name ?? a.id),
        currency: String(a.currency ?? "USD").toUpperCase(),
        active: Number(a.account_status) === 1,
        statusText: ACCOUNT_STATUS[Number(a.account_status)] ?? `Status ${a.account_status}`,
      }));
  }

  async searchCities(userToken: string, query: string): Promise<(AdCity & { country: string })[]> {
    const q = new URLSearchParams({ type: "adgeolocation", location_types: JSON.stringify(["city"]), q: query, limit: "10" });
    const r = await metaGraph(`/search?${q.toString()}`, { token: userToken });
    return (Array.isArray(r.data) ? r.data : [])
      .filter((c: any) => c?.key && c?.name)
      .map((c: any) => ({ key: String(c.key), name: [c.name, c.region].filter(Boolean).join(", "), country: String(c.country_code ?? "") }));
  }

  // شكل الإعلان = البوست نفسه (بلايكاته وتعليقاته)
  private async creativeBody(userToken: string, s: BoostSpec): Promise<Record<string, unknown>> {
    if (s.platform === "INSTAGRAM") {
      if (!s.instagramUserId) throw new SocialPlatformError("This Instagram account isn't linked to a Facebook Page — connect it again.");
      return { object_id: s.pageId, instagram_user_id: s.instagramUserId, source_instagram_media_id: s.postExternalId };
    }
    // بوستات الصور والنص رقمها "صفحة_بوست". الفيديو بيترجع رقمه هو → بنعمل الإعلان من الفيديو نفسه
    if (s.postExternalId.includes("_")) return { object_story_id: s.postExternalId };
    const v = await metaGraph(`/${s.postExternalId}?fields=picture`, { token: userToken });
    return {
      object_story_spec: {
        page_id: s.pageId,
        video_data: { video_id: s.postExternalId, image_url: v.picture, ...(s.caption ? { message: s.caption } : {}) },
      },
    };
  }

  async createBoost(userToken: string, s: BoostSpec): Promise<BoostIds> {
    const goal = GOALS[s.objective];
    const act = s.adAccountId;
    const campaign = await metaGraph(`/${act}/campaigns`, {
      method: "POST",
      token: userToken,
      body: { name: s.name, objective: goal.objective, status: "PAUSED", special_ad_categories: [], is_adset_budget_sharing_enabled: false },
    });
    const campaignId = String(campaign.id);
    try {
      const adSet = await metaGraph(`/${act}/adsets`, {
        method: "POST",
        token: userToken,
        body: {
          name: s.name,
          campaign_id: campaignId,
          daily_budget: s.dailyBudgetMinor,
          billing_event: "IMPRESSIONS",
          optimization_goal: goal.optimization,
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          start_time: s.startAt.toISOString(),
          end_time: s.endAt.toISOString(),
          targeting: targetingFor(s.targeting, s.platform),
          status: "ACTIVE",
        },
      });
      const creative = await metaGraph(`/${act}/adcreatives`, { method: "POST", token: userToken, body: { name: s.name, ...(await this.creativeBody(userToken, s)) } });
      const ad = await metaGraph(`/${act}/ads`, {
        method: "POST",
        token: userToken,
        body: { name: s.name, adset_id: String(adSet.id), creative: { creative_id: String(creative.id) }, status: "ACTIVE" },
      });
      // كله اتعمل → نشغّل الحملة (Meta بتراجع الإعلان الأول وبعدين يبدأ)
      await metaGraph(`/${campaignId}`, { method: "POST", token: userToken, body: { status: "ACTIVE" } });
      return { campaignId, adSetId: String(adSet.id), creativeId: String(creative.id), adId: String(ad.id) };
    } catch (err) {
      await metaGraph(`/${campaignId}`, { method: "DELETE", token: userToken }).catch((e) => console.warn(`[social-ads] cleanup of campaign ${campaignId} failed: ${(e as Error).message}`));
      throw err;
    }
  }

  async setStatus(userToken: string, campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
    await metaGraph(`/${campaignId}`, { method: "POST", token: userToken, body: { status } });
  }

  async setDailyBudget(userToken: string, adSetId: string, dailyBudgetMinor: number): Promise<void> {
    await metaGraph(`/${adSetId}`, { method: "POST", token: userToken, body: { daily_budget: dailyBudgetMinor } });
  }

  async getState(userToken: string, adId: string): Promise<AdState> {
    const r = await metaGraph(`/${adId}?fields=${encodeURIComponent("effective_status,ad_review_feedback,issues_info")}`, { token: userToken });
    // سبب الرفض بييجي جوه ad_review_feedback.global { "سياسة": "الشرح" }
    const global = r.ad_review_feedback?.global;
    const reasons = global && typeof global === "object" ? Object.values(global).map(String) : [];
    const issues = Array.isArray(r.issues_info) ? r.issues_info.map((i: any) => i?.error_summary || i?.error_message).filter(Boolean) : [];
    const feedback = [...reasons, ...issues].join(" · ");
    return { metaStatus: String(r.effective_status ?? "PENDING_REVIEW"), reviewFeedback: feedback || null };
  }

  async getInsights(userToken: string, campaignId: string): Promise<AdInsights> {
    const fields = "impressions,reach,clicks,spend,inline_post_engagement";
    const r = await metaGraph(`/${campaignId}/insights?fields=${fields}&date_preset=maximum`, { token: userToken });
    const row = Array.isArray(r.data) && r.data[0] ? r.data[0] : {};
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { impressions: n(row.impressions), reach: n(row.reach), clicks: n(row.clicks), engagements: n(row.inline_post_engagement), spend: n(row.spend) };
  }
}
