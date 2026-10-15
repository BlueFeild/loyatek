import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { zodMessage } from "../../utils/validation";

// راوتر عام بالكامل - زائر الموقع بيبعت رسالة قبل ما يبقى عنده حساب أصلاً
export const publicContactRouter = Router();

const contactSchema = z.object({
  fullName: z.string().min(2),
  businessEmail: z.string().email(),
  companyName: z.string().min(1),
  message: z.string().min(5),
});

publicContactRouter.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: zodMessage(parsed.error) });

  const saved = await prisma.contactMessage.create({ data: parsed.data });
  res.status(201).json({ ok: true, id: saved.id });
});
