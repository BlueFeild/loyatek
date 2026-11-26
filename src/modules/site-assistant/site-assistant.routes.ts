import { Router } from "express";
import { envNumber, SlidingWindowLimiter } from "../../utils/rate-limit";
import { clientIp, visitorCountry } from "../../utils/visitor-country";
import { chatRequestSchema } from "./site-assistant.types";
import { siteAssistant } from "./site-assistant.wiring";

// POST /api/public/site-assistant/chat - عام (من غير دخول)، حد لكل IP
export const publicSiteAssistantRouter = Router();

const limiter = new SlidingWindowLimiter(envNumber("SITE_ASSISTANT_PER_10MIN", 20), 10 * 60_000);

publicSiteAssistantRouter.post("/chat", async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request", code: "VALIDATION_ERROR" });
  if (limiter.hit(clientIp(req))) {
    return res.status(429).json({
      error: parsed.data.lang === "ar" ? "رسايل كتير في وقت قصير — جرّب تاني بعد شوية." : "Too many messages — please try again in a few minutes.",
      code: "RATE_LIMITED",
    });
  }
  const country = visitorCountry(req, req.body?.country).country;
  res.json(await siteAssistant.chat(parsed.data, country));
});
