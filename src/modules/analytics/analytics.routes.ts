import { Router } from "express";
import { z } from "zod";
import { trackPlatformEvent } from "./analytics.service";
import { SlidingWindowLimiter, envNumber } from "../../utils/rate-limit";
import { clientIp } from "../../utils/visitor-country";

// عدّاد الزيارات العام: حد لكل جهاز (تدقيق MSG-13) عشان محدش يملا الجدول أو يزوّر الأرقام.
// فوق الحد بنرد ok من غير ما نسجّل (الصفحة مش محتاجة تعرف)
const trackLimiter = new SlidingWindowLimiter(envNumber("ANALYTICS_TRACK_PER_10MIN", 60), 10 * 60 * 1000);

export const analyticsRouter = Router();

const trackSchema = z.object({
  path: z.string().min(1).max(300),
});

// عام - من غير تسجيل دخول، بيتنده من أي صفحة عامة (الهوم، الأسعار...)
// عشان نعرف عدد الزيارات الحقيقية للموقع
analyticsRouter.post("/track", async (req, res) => {
  const parsed = trackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (trackLimiter.hit(clientIp(req))) return res.json({ ok: true });
  await trackPlatformEvent({ type: "PAGE_VIEW", path: parsed.data.path });
  res.json({ ok: true });
});
