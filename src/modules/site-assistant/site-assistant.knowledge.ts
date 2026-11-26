import { SERVICE_PAGES, type SiteFacts, type SiteLang } from "./site-assistant.types";

// معلومات المنتج اللي المساعد بيجاوب منها - مكتوبة من النظام الحقيقي (CLAUDE.md).
// الأسعار وأيام التجربة مش هنا: بتتقري لايف وبتتحط في الـ prompt (buildSiteSystemPrompt).
// لو خدمة اتغيّرت أو اتضافت: عدّل هنا.

export interface ServiceInfo {
  id: string;
  name: string;
  nameAr: string;
  forWho: string;
  features: string;
}

export const SERVICES_KB: ServiceInfo[] = [
  {
    id: "booking",
    name: "Booking system",
    nameAr: "نظام الحجوزات",
    forWho: "clinics, salons, spas, photographers, car wash, trainers, vets, any business that takes appointments",
    features:
      "Online booking page with your link + QR, 14 colour templates and several page designs; services with prices, photos, durations, discounts, packages and groups; staff/specialists with photos; weekly opening hours, breaks and holidays; customer picks service, specialist and a free time; questions before booking (answers can add to the price); promo codes; payments: cash, bank transfer, payment link, online card payment (MyFatoorah); WhatsApp confirmation + reminder before the appointment, email notifications; calendar for the team (day/week/list), mark paid, move or cancel a booking.",
  },
  {
    id: "catalog",
    name: "Active Menu and order",
    nameAr: "المنيو والطلبات النشطة",
    forWho: "restaurants, cafés, bakeries, juice shops, food trucks",
    features:
      "Digital QR menu (QR per table), several menu designs and colour templates, dish photos that open big, discounts per dish, promo codes; customers order for dine-in (table) or pickup and pay by cash, transfer, link or card; live orders board and a kitchen screen with order numbers and sound; 'your order is ready' WhatsApp message; customer order tracking page; works in English and Arabic.",
  },
  {
    id: "whatsapp",
    name: "WhatsApp CRM",
    nameAr: "واتساب CRM",
    forWho: "any business that talks to customers on WhatsApp",
    features:
      "Connect your own WhatsApp Business number through Meta (official API, can keep the WhatsApp Business app on the phone); team inbox with assignment, ready replies, away message outside working hours; AI assistant that answers customers in their dialect from your real menu/services/prices/hours, can book appointments in the chat and hands over to a person; offers/campaigns to customer groups with photos, video, PDF, buttons and carousels, scheduling and reports (delivered/read/replied); contacts with tags and Excel import/export; message series (drip), chat flows with buttons, keyword auto-replies; website chat button; Click-to-WhatsApp ads tracking. Meta's own WhatsApp message fees are paid by the business directly to Meta (no markup from BlueField).",
  },
  {
    id: "wallet",
    name: "Wallet Loyalty",
    nameAr: "بطاقة الولاء",
    forWho: "cafés, restaurants, salons, car wash, shops with returning customers",
    features:
      "Digital loyalty card in Google Wallet (stamps, points or cashback); customer joins by scanning a QR; staff gives stamps by scanning the customer's card with the phone camera; gift after N stamps; your logo, colours and stamp icons; member list and activity log.",
  },
  {
    id: "erp",
    name: "ERP & Accounts",
    nameAr: "ERP والحسابات",
    forWho: "businesses that need accounting, stock, staff and branches in one place",
    features:
      "Invoices with payments, PDF and customer statements; bills to pay; double-entry books, profit & loss, trial balance, balance sheet; stock and products; suppliers, purchase orders and quotes; team & salaries; sales; CRM deals; budgets; branches with their own figures; equipment, vehicles, manufacturing, support tickets, tasks; multi-currency; demo data to try it.",
  },
  {
    id: "linktree",
    name: "Link-in-Bio",
    nameAr: "Link-in-Bio",
    forWho: "anyone with an Instagram/TikTok account, creators, shops",
    features:
      "One page with all your links (for your Instagram/TikTok bio), 21 looks, cover photo, own background, social icons, file uploads (menus, PDFs), click counts, QR code, links to your other BlueField pages.",
  },
  {
    id: "ai",
    name: "AI Studio",
    nameAr: "استوديو الذكاء الاصطناعي",
    forWho: "businesses that make their own marketing content",
    features:
      "AI writer for captions, ads, product descriptions, hashtags, SMS and WhatsApp texts in Qatari, Gulf, Egyptian, Modern Standard Arabic or English; AI image creator; AI short videos. Works with monthly credits included in the subscription.",
  },
  {
    id: "social",
    name: "Social Media & Ads",
    nameAr: "السوشيال ميديا والإعلانات",
    forWho: "businesses that post on Facebook, Instagram, TikTok and run ads",
    features:
      "Connect Facebook Page, Instagram, TikTok and Bluesky; post now or schedule, content calendar, repeating posts, client approval links; one inbox for comments and DMs with AI reply suggestions; comment-to-DM automation; monthly white-label report; Paid Ads: boost a post on Facebook/Instagram (including Click-to-WhatsApp ads) with budget limits; Account Audit: AI report about a social account. TikTok/Snapchat ads are not available yet.",
  },
  {
    id: "walogin",
    name: "API WhatsApp login",
    nameAr: "API تسجيل الدخول بالواتساب",
    forWho: "businesses and developers who want customers to log in or verify their phone with a WhatsApp code",
    features:
      "Customers get a one-time code on WhatsApp from your number; ready widget for your website + API; can be required on your booking page. Meta charges a small authentication fee per code (paid to Meta).",
  },
  {
    id: "tickets",
    name: "Tickets & Seats",
    nameAr: "التذاكر والمقاعد",
    forWho: "theatres, events, concerts, workshops, VIP seating",
    features:
      "Draw your hall with rows, levels and prices; customers pick their seats on a live seat map; QR tickets; door check-in with the phone camera; promo codes and early-bird prices; box-office sales and free tickets; questions for buyers; several dates for one show; waiting list; reminders; reports and door list.",
  },
  {
    id: "store",
    name: "Online Store",
    nameAr: "المتجر الإلكتروني",
    forWho: "shops selling products: accessories, perfumes, clothes, sportswear, gifts",
    features:
      "Online shop with categories, products with photo albums, options (size/colour) and stock; cart and checkout with delivery or pickup; payment by cash, transfer, link or card; orders board (new → confirmed → shipped → delivered) with tracking link; coupons; contact page; can sync with WooCommerce.",
  },
  {
    id: "properties",
    name: "Property Catalog",
    nameAr: "كتالوج العقارات",
    forWho: "real-estate companies and agents",
    features:
      "List properties for sale or rent with photo albums, price (or 'on request'), area, rooms, bathrooms, parking, furnished, features and map link; public catalogue page in English and Arabic; visitors send enquiries or call/WhatsApp directly.",
  },
  {
    id: "sms",
    name: "SMS Messages",
    nameAr: "رسائل SMS",
    forWho: "businesses that send SMS to customers",
    features:
      "Send a single SMS or SMS campaigns to customer groups, schedule them, history. The subscription includes a monthly SMS balance; one SMS = 160 English letters or 70 Arabic letters; extra cost depends on the country.",
  },
  {
    id: "website",
    name: "Informative Website",
    nameAr: "الموقع التعريفي",
    forWho: "clinics, companies, small businesses that need a simple professional website",
    features:
      "One-page company website with ready premium templates, sections (about, services, gallery, team, testimonials, packages, FAQ, hours, call to action, contact form), photo gallery, floating WhatsApp button, English and Arabic, messages from visitors in the dashboard.",
  },
];

function money(currency: string, n: number): string {
  const d = /^(KWD|BHD|OMR|JOD)$/.test(currency) ? 3 : 0;
  return `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, 2) })}`;
}

// سطر السعر لكل خدمة (من الأرقام الحقيقية)
export function priceLines(f: SiteFacts): string[] {
  return SERVICES_KB.map((s) => {
    const p = f.monthly[s.id];
    if (p == null) return `- ${s.name}: price not available — send them to /pricing`;
    const d = f.discounts[s.id];
    const orig = f.original[s.id];
    const disc = d && orig != null && orig !== p ? ` (discount ${d.pct}% from ${money(f.currency, orig)}${d.endsAt ? `, until ${d.endsAt.slice(0, 10)}` : ""})` : "";
    return `- ${s.name}: ${money(f.currency, p)} per month${disc}`;
  });
}

export function buildSiteSystemPrompt(f: SiteFacts, lang: SiteLang, page?: string | null): string {
  const services = SERVICES_KB.map(
    (s) => `### ${s.name} (Arabic name: ${s.nameAr}) — page /solutions/${SERVICE_PAGES[s.id]}\nGood for: ${s.forWho}\nWhat it does: ${s.features}`
  ).join("\n\n");
  const trial =
    f.trialDays > 0
      ? `New companies get a free trial of ${f.trialDays} day${f.trialDays === 1 ? "" : "s"} with all services, no card needed.`
      : "There is currently no free trial — new companies subscribe to start.";

  return `You are "Ask BlueField", the friendly assistant on the BlueField website (digital.blue-field.co).
You help visitors understand the BlueField platform and choose the services that fit their business.

## About BlueField
BlueField is one platform with ${SERVICES_KB.length} services for businesses (made by BlueField Photography, Qatar). One login, one dashboard:
the business picks only the services it needs and pays per service, monthly or yearly. It can add or remove services later.
Everything works in English and Arabic, on phone and computer. Customer pages (booking page, menu, store, link-in-bio, website…) get their own link and QR.
Sign up at /signup, see all services at /solutions, prices at /pricing, contact the team at /contact or support@blue-field.co.

## Live facts (use ONLY these numbers)
Visitor's country: ${f.country ?? "unknown"}; prices shown in ${f.currency}.
${trial}
Monthly prices:
${priceLines(f).join("\n")}
Yearly plan: ${f.yearlyDiscountPct}% cheaper than paying monthly.
Extra company/branch profile: ${money(f.currency, f.extraCompanyPrice)} per month base fee.
AI Studio includes ${f.aiMonthlyCredits} AI credits per month. SMS includes ${f.smsMonthlyIncluded} SMS per month.
WhatsApp message fees: Meta charges per conversation/message category and the business pays Meta directly (BlueField adds nothing); the calculator on /pricing shows an estimate per country.
SMS cost beyond the included balance depends on the country (approximate, shown on /pricing).

## Services
${services}

## Rules
- Answer only about BlueField and how it helps the visitor's business. For unrelated questions, politely bring the chat back to BlueField.
- Recommend the services that fit the visitor's business type and explain why in one short line each.
- NEVER invent features, prices, discounts, dates, integrations or promises. Use only the facts above. If something isn't listed or you are not sure, say so and suggest contacting the team (/contact or support@blue-field.co).
- Prices: only the numbers above, in ${f.currency}. Do not convert currencies yourself.
- Keep answers short: 2–5 short sentences or a few bullet points. No markdown headings, no tables.
- Reply in the visitor's language: ${lang === "ar" ? "the visitor is on the Arabic site — reply in simple, friendly Arabic (easy for Gulf and Egyptian readers) unless they write in English" : "reply in English unless the visitor writes in Arabic (then reply in simple, friendly Arabic easy for Gulf and Egyptian readers)"}. Service names may stay in English.
- "suggestions": up to 3 short follow-up questions the visitor might ask next, in the same language as your reply.
- "links": up to 3 helpful pages, each {path, label}. Allowed paths only: /pricing, /solutions, /solutions/<service page>, /contact, /signup, /about. Label in the reply's language.
- Never ask for passwords, card numbers or personal data.
${page ? `\nThe visitor is currently on this page: ${page.slice(0, 120)}` : ""}`;
}
