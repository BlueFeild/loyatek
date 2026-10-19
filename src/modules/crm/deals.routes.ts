import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { advanceDeal, markDealLost } from "./deals.service";
import { assertTenantOwns } from "../../utils/tenant-owned";

export const dealsRouter = Router();

dealsRouter.use(requireAuth, requireModule("erp"));

dealsRouter.get("/", async (req, res) => {
  const deals = await prisma.deal.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { customer: true },
    orderBy: { updatedAt: "desc" },
  });
  res.json(deals);
});

const createDealSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(2),
  value: z.number().min(0),
});

dealsRouter.post("/", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createDealSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await assertTenantOwns(req.auth!.tenantId, { customerIds: [parsed.data.customerId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const [deal] = await prisma.$transaction([
    prisma.deal.create({ data: { tenantId: req.auth!.tenantId, ...parsed.data }, include: { customer: true } }),
    prisma.activity.create({
      data: {
        tenantId: req.auth!.tenantId,
        customerId: parsed.data.customerId,
        type: "STAGE_CHANGE",
        text: `New deal "${parsed.data.name}" created at LEAD stage`,
      },
    }),
  ]);
  res.status(201).json(deal);
});

// تحريك الصفقة للمرحلة الجاية في التسلسل (LEAD → QUALIFIED → PROPOSAL → WON)
dealsRouter.post("/:id/advance", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const deal = await advanceDeal(req.auth!.tenantId, req.params.id);
    res.json(deal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

dealsRouter.post("/:id/lost", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  try {
    const deal = await markDealLost(req.auth!.tenantId, req.params.id);
    res.json(deal);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

const updateDealSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  value: z.number().min(0).optional(),
  // أي مرحلة - قدام أو رجوع (لو حصل تغيير أو غلطة)
  stage: z.enum(["LEAD", "QUALIFIED", "PROPOSAL", "WON", "LOST"]).optional(),
});

// تعديل الصفقة: الاسم والقيمة، ونقلها لأي مرحلة (مع تسجيل التغيير في Timeline العميل)
dealsRouter.patch("/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = updateDealSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid change" });
  const tenantId = req.auth!.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: req.params.id, tenantId } });
  if (!deal) return res.status(404).json({ error: "Deal not found" });
  const d = parsed.data;
  const notes: string[] = [];
  if (d.stage && d.stage !== deal.stage) notes.push(`Deal "${deal.name}" moved from ${deal.stage} to ${d.stage}`);
  if (d.value !== undefined && d.value !== Number(deal.value)) notes.push(`Deal "${deal.name}" value changed from ${Number(deal.value)} to ${d.value}`);
  if (d.name && d.name !== deal.name) notes.push(`Deal "${deal.name}" renamed to "${d.name}"`);
  const [updated] = await prisma.$transaction([
    prisma.deal.update({ where: { id: deal.id }, data: d, include: { customer: true } }),
    ...notes.map((text) => prisma.activity.create({ data: { tenantId, customerId: deal.customerId, type: "STAGE_CHANGE", text } })),
  ]);
  res.json(updated);
});
