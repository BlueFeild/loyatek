import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requireModule } from "../../middleware/module-access";
import { assertTenantOwns } from "../../utils/tenant-owned";

export const opsRouter = Router();
opsRouter.use(requireAuth, requireModule("erp"));

opsRouter.get("/tasks", async (req, res) => {
  const tasks = await prisma.opsTask.findMany({
    where: { tenantId: req.auth!.tenantId },
    include: { assignee: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(tasks);
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

opsRouter.post("/tasks", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  // المسؤول عن المهمة لازم يكون موظف في نفس الشركة
  try {
    await assertTenantOwns(req.auth!.tenantId, { employeeIds: [parsed.data.assigneeId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const branch = await prisma.branch.findFirst({ where: { tenantId: req.auth!.tenantId } });
  if (!branch) return res.status(400).json({ error: "No branch found for this company" });

  const task = await prisma.opsTask.create({
    data: {
      tenantId: req.auth!.tenantId,
      branchId: branch.id,
      title: parsed.data.title,
      description: parsed.data.description ?? "",
      priority: parsed.data.priority,
      assigneeId: parsed.data.assigneeId ?? undefined,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
    },
    include: { assignee: { select: { id: true, name: true } } },
  });
  res.status(201).json(task);
});

const updateTaskSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

// التعديل (PATCH) متاح لكل الأدوار المسجّلة دخول عمدًا - أي موظف
// لازم يقدر يحدّث حالة مهمته بنفسه (TODO → In Progress → Done)، لكن
// الحذف النهائي والإنشاء (توزيع مهام جديدة) مقصورين على الإدارة
opsRouter.patch("/tasks/:id", async (req, res) => {
  const parsed = updateTaskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const task = await prisma.opsTask.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  // تدقيق ERP-12: الموظف (STAFF) بيغيّر حالة مهمته هو بس (أو مهمة مش متوزّعة على حد) -
  // العنوان/المسؤول/الأولوية/الميعاد للإدارة
  if (req.auth!.role === "STAFF") {
    const keys = Object.keys(parsed.data).filter((k) => (parsed.data as Record<string, unknown>)[k] !== undefined);
    if (keys.some((k) => k !== "status")) return res.status(403).json({ error: "Only managers can edit a task's details" });
    if (task.assigneeId) {
      const me = await prisma.employee.findFirst({ where: { tenantId: req.auth!.tenantId, userId: req.auth!.userId }, select: { id: true } });
      if (me?.id !== task.assigneeId) return res.status(403).json({ error: "This task is assigned to someone else" });
    }
  }
  try {
    await assertTenantOwns(req.auth!.tenantId, { employeeIds: [parsed.data.assigneeId] });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const updated = await prisma.opsTask.update({
    where: { id: task.id },
    data: {
      ...parsed.data,
      dueDate: parsed.data.dueDate !== undefined ? (parsed.data.dueDate ? new Date(parsed.data.dueDate) : null) : undefined,
    },
    include: { assignee: { select: { id: true, name: true } } },
  });
  res.json(updated);
});

opsRouter.delete("/tasks/:id", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const task = await prisma.opsTask.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (!task) return res.status(404).json({ error: "Task not found" });

  await prisma.opsTask.delete({ where: { id: task.id } });
  res.json({ ok: true });
});
