import { buildSiteSystemPrompt } from "./site-assistant.knowledge";
import { SITE_ASSISTANT_LIMITS, type ChatRequest, type SiteAnswer, type SiteAssistantModel, type SiteFactsSource, type SiteLang } from "./site-assistant.types";

export interface SiteChatResult extends SiteAnswer {
  // true = المزوّد مش متاح/وقع ← رد احتياطي ثابت (مش 500)
  fallback: boolean;
}

const FALLBACK: Record<SiteLang, SiteAnswer> = {
  en: {
    reply: "Sorry, I can't answer right now. Our team will gladly help you — send us a message or email support@blue-field.co.",
    suggestions: [],
    links: [
      { path: "/contact", label: "Contact the team" },
      { path: "/pricing", label: "See prices" },
    ],
  },
  ar: {
    reply: "آسفين، مش قادر أرد دلوقتي. فريقنا هيساعدك بكل سرور — ابعتلنا رسالة أو إيميل على support@blue-field.co.",
    suggestions: [],
    links: [
      { path: "/contact", label: "كلّم الفريق" },
      { path: "/pricing", label: "شوف الأسعار" },
    ],
  },
};

// "اسأل BlueField": يبني الـ prompt من الحقايق اللايف (أسعار بعملة الزائر + أيام التجربة) ويسأل المزوّد.
// مفيش نقاط، ومفيش تخزين لرسايل الزوار.
export class SiteAssistantService {
  constructor(
    private readonly model: SiteAssistantModel | null,
    private readonly facts: SiteFactsSource
  ) {}

  get isAvailable() {
    return this.model !== null;
  }

  async chat(req: ChatRequest, country: string | null): Promise<SiteChatResult> {
    const lang: SiteLang = req.lang === "ar" ? "ar" : "en";
    // آخر 12 رسالة، ولازم تبدأ برسالة من الزائر وتخلص برسالة منه
    let messages = req.messages.slice(-SITE_ASSISTANT_LIMITS.maxTurns);
    while (messages.length && messages[0].role !== "user") messages = messages.slice(1);
    if (!messages.length || messages[messages.length - 1].role !== "user") return { ...FALLBACK[lang], fallback: true };
    if (!this.model) return { ...FALLBACK[lang], fallback: true };
    try {
      const system = buildSiteSystemPrompt(await this.facts.facts(country), lang, req.page ?? null);
      const answer = await this.model.reply({ system, messages });
      return { ...answer, fallback: false };
    } catch (err) {
      console.warn(`[site-assistant] reply failed: ${(err as Error)?.message}`);
      return { ...FALLBACK[lang], fallback: true };
    }
  }
}
