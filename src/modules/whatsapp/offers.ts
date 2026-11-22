import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db";
import { requireRole } from "../../middleware/auth";
import { container } from "../../core/container";
import { NotFoundError, ValidationError } from "../../core/errors";
import { DIALECTS } from "../ai/copy-generator";
import { normalizePhone } from "./contact-book.service";

// "ابعت عرض" (شاشة واتساب المبسطة): مجموعات جاهزة من بيانات التاجر الحقيقية + كتابة العرض بالذكاء الاصطناعي.
// الإرسال نفسه بيعدّي على نفس الحملات (CampaignSender) - هنا بس اختيار الجمهور والنص.

export const OFFER_LIMITS = {
  inactiveDays: 60, // "مجوش من شهرين"
  maxRecipients: 20_000,
  maxScan: 50_000, // أقصى عدد حجوزات/طلبات بنقراهم لحساب آخر زيارة
};

export type OfferGroup = "all" | "inactive";
type Person = { phone: string; name: string };

// آخر زيارة لكل عميل (حجز أو طلب) ← اللي آخر زيارة ليه أقدم من cutoff
export function inactiveCustomers(visits: { phone: string; name: string | null; at: Date }[], cutoff: Date): Person[] {
  const last = new Map<string, { at: Date; name: string }>();
  for (const v of visits) {
    const phone = normalizePhone(v.phone);
    if (!phone) continue;
    const cur = last.get(phone);
    if (!cur || v.at > cur.at) last.set(phone, { at: v.at, name: v.name?.trim() || cur?.name || "" });
    else if (!cur.name && v.name?.trim()) cur.name = v.name.trim();
  }
  const out: Person[] = [];
  for (const [phone, v] of last) if (v.at < cutoff) out.push({ phone, name: v.name || "Customer" });
  return out;
}

export class OfferAudienceService {
  constructor(private readonly db: PrismaClient) {}

  private async optedOut(tenantId: string) {
    const rows = await this.db.whatsappContact.findMany({ where: { tenantId, optedOut: true }, select: { phone: true } });
    return new Set(rows.map((r) => r.phone));
  }

  private async inactive(tenantId: string, now: Date) {
    const cutoff = new Date(now.getTime() - OFFER_LIMITS.inactiveDays * 86400_000);
    const [bookings, orders] = await Promise.all([
      this.db.booking.findMany({ where: { tenantId }, select: { customerPhone: true, customerName: true, date: true }, orderBy: { date: "desc" }, take: OFFER_LIMITS.maxScan }),
      this.db.catalogOrder.findMany({ where: { tenantId }, select: { customerPhone: true, customerName: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: OFFER_LIMITS.maxScan }),
    ]);
    const visits = [
      ...bookings.map((b) => ({ phone: b.customerPhone, name: b.customerName, at: b.date })),
      ...orders.map((o) => ({ phone: o.customerPhone, name: o.customerName, at: o.createdAt })),
    ];
    return inactiveCustomers(visits, cutoff);
  }

  // الناس في مجموعة (من غير اللي قالوا STOP)
  async people(tenantId: string, group: OfferGroup, now = new Date()): Promise<Person[]> {
    const skip = await this.optedOut(tenantId);
    let list: Person[];
    if (group === "inactive") list = await this.inactive(tenantId, now);
    else {
      const rows = await this.db.whatsappContact.findMany({ where: { tenantId, optedOut: false }, select: { phone: true, name: true }, take: OFFER_LIMITS.maxRecipients });
      list = rows.map((r) => ({ phone: r.phone, name: r.name || "Customer" }));
    }
    return list.filter((p) => !skip.has(p.phone)).slice(0, OFFER_LIMITS.maxRecipients);
  }

  async summary(tenantId: string, now = new Date()) {
    const [all, inactive, tagRows] = await Promise.all([
      this.db.whatsappContact.count({ where: { tenantId, optedOut: false } }),
      this.people(tenantId, "inactive", now),
      this.db.$queryRaw<{ tag: string; count: number }[]>`
        SELECT t AS "tag", COUNT(*)::int AS "count" FROM "whatsapp_contacts", unnest("tags") AS t
        WHERE "tenantId" = ${tenantId} AND "optedOut" = false GROUP BY t ORDER BY COUNT(*) DESC LIMIT 30`,
    ]);
    return { all, inactive: inactive.length, inactiveDays: OFFER_LIMITS.inactiveDays, tags: tagRows };
  }

  // الحملة تاخد المجموعة كقايمة مستلمين ثابتة (نفس سلوك ملف الإكسل)
  async useGroup(tenantId: string, campaignId: string, group: OfferGroup) {
    const own = await this.db.whatsappCampaign.findFirst({ where: { id: campaignId, tenantId }, select: { id: true } });
    if (!own) throw new NotFoundError("Campaign not found");
    const people = await this.people(tenantId, group);
    if (people.length === 0) throw new ValidationError(group === "inactive" ? "Nobody fits this group yet." : "You have no contacts yet — import a list or sync your customers first.");
    const r = await this.db.whatsappCampaign.updateMany({
      where: { id: campaignId, tenantId, status: { not: "SENDING" } },
      data: { recipients: people, audienceTags: [], status: "DRAFT", scheduledAt: null, sentCount: 0, failedCount: 0, skippedCount: 0, lastError: null },
    });
    if (r.count === 0) throw new NotFoundError("Campaign not found or being sent right now.");
    return { ok: true, recipientCount: people.length };
  }
}

const audiences = new OfferAudienceService(prisma);

export const offersRouter = Router();

offersRouter.get("/audiences", async (req, res) => {
  res.json(await audiences.summary(req.auth!.tenantId));
});

const groupSchema = z.object({ group: z.enum(["all", "inactive"]) });
offersRouter.post("/campaigns/:id/group", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Choose who gets it.");
  res.json(await audiences.useGroup(req.auth!.tenantId, req.params.id, parsed.data.group));
});

// تكلفة ميتا التقريبية قبل الإرسال (رسالة تسويقية، حسب دولة كل رقم) - بتتدفع لميتا مش لينا
const estimateSchema = z.object({ group: z.enum(["all", "inactive"]).optional(), tag: z.string().trim().min(1).max(60).optional() });
offersRouter.get("/estimate", async (req, res) => {
  const parsed = estimateSchema.safeParse(req.query);
  if (!parsed.success || (!parsed.data.group && !parsed.data.tag)) throw new ValidationError("Choose who gets it.");
  const tenantId = req.auth!.tenantId;
  const phones = parsed.data.tag
    ? (await prisma.whatsappContact.findMany({ where: { tenantId, optedOut: false, tags: { has: parsed.data.tag.toLowerCase() } }, select: { phone: true } })).map((r) => r.phone)
    : (await audiences.people(tenantId, parsed.data.group!)).map((p) => p.phone);
  const estimator = await container.metaRatesService.estimator();
  res.json({ count: phones.length, ...estimator.estimate(phones, "marketing") });
});

// العرض بكلام التاجر ← رسالة واتساب جاهزة (1 رصيد، نفس الكاتب الذكي)
const writeSchema = z.object({
  idea: z.string().trim().min(3, "Write your idea in a few words").max(300),
  dialect: z.enum(DIALECTS).default("qatari"),
});
offersRouter.post("/write", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Write your idea");
  const r = await container.copywriterService.write(req.auth!.tenantId, req.auth!.userId ?? null, {
    kind: "whatsapp",
    dialect: parsed.data.dialect,
    tone: "friendly",
    platform: "any",
    topic: parsed.data.idea,
    details: "A WhatsApp offer message sent to many customers. Short (max ~350 characters), 1-2 emojis, no hashtags, no links, no prices or dates that the merchant did not write. Do not add a greeting with a name — it is added automatically.",
    variants: 1,
  });
  res.json({ text: r.variants[0]?.text ?? "", balance: r.balance });
});
