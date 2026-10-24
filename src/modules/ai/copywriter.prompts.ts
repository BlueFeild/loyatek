import type { BusinessContext, CopyBrief } from "./copy-generator";

// كل نصوص التعليمات في مكان واحد (سهل تتعدّل من غير ما نلمس الكود)
const DIALECT_GUIDE: Record<CopyBrief["dialect"], string> = {
  qatari: "Qatari Arabic dialect, natural, as Qataris write on social media.",
  gulf: "general Gulf Arabic dialect, understood across Qatar, UAE, Saudi Arabia and Kuwait.",
  msa: "Modern Standard Arabic (fusha), clear and elegant, not stiff.",
  egyptian: "Egyptian Arabic dialect.",
  english: "English.",
};

const KIND_GUIDE: Record<CopyBrief["kind"], string> = {
  caption:
    "a social media post caption with a hook in the first line, a short body and a clear call to action. Usually 2-5 short lines.",
  ad: "paid-ad copy: a punchy headline line, one benefit line and a call to action. Keep the main text under 125 characters.",
  product:
    "a product description for an online store: a one-line hook, 3-5 short benefit bullets (start each with •), then a one-line call to action.",
  hashtags:
    "a set of 15-20 relevant hashtags (a mix of popular Qatar/Gulf tags, niche tags and one brand tag). Put the tags in the hashtags list; the text is one short line explaining the mix.",
  sms: "an SMS marketing message. HARD LIMIT: 70 characters for Arabic or 160 for English (one SMS segment), including the call to action. No hashtags and no emojis.",
  whatsapp:
    "a WhatsApp marketing message: a friendly greeting, the offer in 2-3 short lines and a call to action. Light emoji use. No hashtags.",
};

export const COPYWRITER_SYSTEM = `You are a senior marketing copywriter for businesses in Qatar and the Gulf.
Write copy that sounds like a local professional wrote it and respects Gulf culture and Islamic values.
Never invent prices, discounts, dates, phone numbers, addresses or claims that the merchant did not give you; if a detail is missing, write around it (for example "contact us" instead of a made-up number).
Each variant takes a clearly different angle (for example benefit-led, emotion-led, offer-led).
Hashtags have no spaces and start with #; return an empty hashtags list when the kind does not use hashtags.`;

const PLATFORM_KINDS: CopyBrief["kind"][] = ["caption", "ad", "hashtags"];

export function buildCopyPrompt(brief: CopyBrief, business: BusinessContext): string {
  return [
    `Business: ${business.name} (industry: ${business.industry.toLowerCase()}).`,
    `Write ${brief.variants} variant(s) of ${KIND_GUIDE[brief.kind]}`,
    `Language: ${DIALECT_GUIDE[brief.dialect]}`,
    `Tone: ${brief.tone}.`,
    PLATFORM_KINDS.includes(brief.kind) ? `Platform: ${brief.platform}.` : "",
    `Topic: ${brief.topic}`,
    brief.details ? `Facts from the merchant you may use:\n${brief.details}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
