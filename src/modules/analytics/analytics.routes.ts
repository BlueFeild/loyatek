import { Router } from "express";
import { z } from "zod";
import { trackPlatformEvent } from "./analytics.service";

export const analyticsRouter = Router();

const trackSchema = z.object({
  path: z.string().min(1).max(300),
});

// عام - من غير تسجيل دخول، بيتنده من أي صفحة عامة (الهوم، الأسعار...)
// عشان نعرف عدد الزيارات الحقيقية للموقع
analyticsRouter.post("/track", async (req, res) => {
  const parsed = trackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  await trackPlatformEvent({ type: "PAGE_VIEW", path: parsed.data.path });
  res.json({ ok: true });
});
