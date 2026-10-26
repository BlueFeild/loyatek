import type { BusinessContext } from "./copy-generator";
import type { AuditInput, AuditMetrics, ImageBrief } from "./media-types";

// تعليمات الصور والفيديو والتحليل في مكان واحد (سهل تتعدّل من غير ما نلمس الكود)

const SCENES: Record<ImageBrief["scene"], string> = {
  none: "",
  studio: "a clean professional studio with soft, even lighting",
  lusail: "an elegant evening setting with the Lusail city skyline in Qatar softly blurred in the background",
  souq_waqif: "a warm traditional setting inspired by Souq Waqif in Doha, with soft lantern light",
  majlis: "a luxurious Qatari majlis interior with rich textures and warm light",
  corniche: "the Doha Corniche at golden hour with the West Bay towers in the distance",
  desert: "golden Qatari desert dunes at sunset",
  pearl: "a refined marina setting inspired by The Pearl-Qatar",
  flat_lay: "a tidy top-down flat lay on a neutral surface",
};

const STYLES: Record<ImageBrief["style"], string> = {
  photo: "photorealistic commercial photography",
  luxury: "premium luxury advertising look, elegant and rich",
  minimal: "minimal, clean composition with plenty of negative space",
  vibrant: "bright, vibrant, eye-catching social media look",
  illustration: "modern flat illustration",
};

export function buildImagePrompt(brief: ImageBrief, business: BusinessContext): string {
  const parts = [
    `Create a marketing image for "${business.name}" (${business.industry.toLowerCase()}), a business in Qatar.`,
    `Style: ${STYLES[brief.style]}.`,
    SCENES[brief.scene] ? `Setting: ${SCENES[brief.scene]}.` : "",
    brief.productImage
      ? "Use the attached product photo: remove its original background and place the exact same product (do not change its shape, colours, label or logo) naturally into the new setting with realistic lighting and shadow."
      : "",
    `What to show: ${brief.prompt}`,
    "Respectful of Gulf culture: modest clothing if people appear, no alcohol, no text overlays unless asked, no other brands' logos.",
  ];
  return parts.filter(Boolean).join("\n");
}

export function buildVideoPrompt(prompt: string, business: BusinessContext, animatingImage: boolean): string {
  return [
    animatingImage
      ? `Animate this image into a short, smooth marketing video for "${business.name}", a business in Qatar. Keep the product exactly as it is.`
      : `A short marketing video for "${business.name}" (${business.industry.toLowerCase()}), a business in Qatar.`,
    prompt,
    "Smooth cinematic camera movement, respectful of Gulf culture, no on-screen text, no other brands' logos.",
  ].join("\n");
}

export const AUDIT_SYSTEM = `You are a senior social media strategist for businesses in Qatar and the Gulf.
You write an honest account audit for the merchant in clear, simple English.
Use only the numbers and screenshots you are given; never invent follower counts, statistics or results. If something is unknown, say what to check.
healthScore is 0-100 (50 = average for the niche in the Gulf).
The ad plan budget is in Qatari riyals (QAR) per day and must be realistic for a small business (usually 30-300 QAR/day).
Content ideas must fit Gulf culture and Qatari seasons (Ramadan, Eid, National Day, summer, back to school) where relevant.`;

export function buildAuditPrompt(input: AuditInput, metrics: AuditMetrics, business: BusinessContext): string {
  const n = (v: number | undefined) => (v === undefined ? "unknown" : String(v));
  return [
    `Business: ${business.name} (industry: ${business.industry.toLowerCase()}).`,
    `Platform: ${input.platform}. Account: ${input.handle}.`,
    input.niche ? `Niche: ${input.niche}.` : "",
    input.goal ? `Merchant's goal: ${input.goal}.` : "",
    `Followers: ${n(input.followers)}. Following: ${n(input.following)}. Posts per week: ${n(input.postsPerWeek)}.`,
    `Average likes: ${n(input.avgLikes)}. Average comments: ${n(input.avgComments)}. Average views: ${n(input.avgViews)}.`,
    `Engagement rate (calculated): ${metrics.engagementRate === null ? "unknown" : `${metrics.engagementRate}%`}. View rate: ${metrics.viewRate === null ? "unknown" : `${metrics.viewRate}%`}.`,
    input.screenshots.length ? `${input.screenshots.length} screenshot(s) of the account/insights are attached — read them carefully.` : "No screenshots were provided.",
    "Give 3-5 items in each SWOT list, 3-5 quick wins and 4-6 content plan items.",
  ]
    .filter(Boolean)
    .join("\n");
}
