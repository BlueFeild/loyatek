import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../config/db";
import { requireAuth, requireRole } from "../../middleware/auth";
import { enrichEmployee, upsertShift, upsertAttendance, getWeekDates } from "./hr.service";

export const employeesRouter = Router();

employeesRouter.use(requireAuth);

// قائمة الموظفين + بيانات الحضور والهدف/الفعلي المحسوبة فعليًا لكل واحد
employeesRouter.get("/", async (req, res) => {
  const employees = await prisma.employee.findMany({
    where: { tenantId: req.auth!.tenantId },
    orderBy: { createdAt: "desc" },
  });

  const enriched = await Promise.all(
    employees.map(async (e: { id: string; monthlyTarget: unknown }) => ({
      ...e,
      ...(await enrichEmployee(req.auth!.tenantId, e)),
    }))
  );
  res.json(enriched);
});

const createEmployeeSchema = z.object({
  branchId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  name: z.string().min(2),
  position: z.string().min(2),
  commissionRate: z.number().min(0).max(1).default(0), // 0.05 = 5%
  baseSalary: z.number().min(0).default(0),
  monthlyTarget: z.number().min(0).default(0),
});

employeesRouter.post("/", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const employee = await prisma.employee.create({
    data: { tenantId: req.auth!.tenantId, ...parsed.data },
  });
  res.status(201).json(employee);
});

// تقرير عمولة موظف معيّن - مبني على المبيعات الفعلية المسجلة له، مش رقم مقدّر
employeesRouter.get("/:id/commissions", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const sales = await prisma.sale.findMany({
    where: { employeeId: employee.id },
    include: { item: true },
    orderBy: { createdAt: "desc" },
  });

  const totalCommission = sales.reduce(
    (sum: number, s: { commissionAmount: unknown }) => sum + Number(s.commissionAmount),
    0
  );
  const totalSalesAmount = sales.reduce(
    (sum: number, s: { totalAmount: unknown }) => sum + Number(s.totalAmount),
    0
  );

  res.json({ employee, totalSalesAmount, totalCommission, sales });
});

// كشف راتب مبسّط - راتب أساسي + عمولة الشهر الحالي، محسوبين من بيانات حقيقية
employeesRouter.get("/:id/payslip", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const sales = await prisma.sale.findMany({
    where: { employeeId: employee.id, createdAt: { gte: monthStart, lt: nextMonthStart } },
  });
  const commissionThisMonth = sales.reduce(
    (sum: number, s: { commissionAmount: unknown }) => sum + Number(s.commissionAmount),
    0
  );

  res.json({
    employee,
    period: { start: monthStart, end: nextMonthStart },
    baseSalary: Number(employee.baseSalary),
    commissionThisMonth,
    totalPay: Number(employee.baseSalary) + commissionThisMonth,
  });
});

// --- Shifts (جدول المناوبات الأسبوعي) ---

const upsertShiftSchema = z.object({
  date: z.string(), // "2026-08-10"
  type: z.enum(["AM", "PM", "FULL", "OFF"]),
});

employeesRouter.post("/:id/shifts", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = upsertShiftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const shift = await upsertShift(req.auth!.tenantId, employee.id, new Date(parsed.data.date), parsed.data.type);
  res.status(201).json(shift);
});

// جدول أسبوع كامل (7 أيام) لموظف - يرجع null للأيام اللي لسه معملهاش مناوبة
employeesRouter.get("/:id/shifts", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const weekStartParam = req.query.weekStart as string | undefined;
  const weekStart = weekStartParam ? new Date(weekStartParam) : new Date();
  const days = getWeekDates(weekStart);

  const shifts = await prisma.shift.findMany({
    where: { employeeId: employee.id, date: { gte: days[0], lte: days[6] } },
  });

  const byDate = new Map(shifts.map((s: { date: Date; type: string }) => [new Date(s.date).toDateString(), s.type]));
  const week = days.map((d) => ({ date: d.toISOString().slice(0, 10), type: byDate.get(d.toDateString()) ?? null }));

  res.json(week);
});

// حالة الحضور الحالية للنهاردة (لو مسجلة)
employeesRouter.get("/:id/attendance/today", async (req, res) => {
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const record = await prisma.attendance.findFirst({
    where: { employeeId: employee.id, date: today },
  });
  res.json({ status: record?.status ?? null });
});

const upsertAttendanceSchema = z.object({
  date: z.string().optional(), // افتراضيًا النهاردة لو ما اتبعتش
  status: z.enum(["ON_SHIFT", "BREAK", "OFF", "ABSENT"]),
});

employeesRouter.post("/:id/attendance", requireRole("OWNER", "ADMIN", "MANAGER"), async (req, res) => {
  const parsed = upsertAttendanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const employee = await prisma.employee.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
  });
  if (!employee) return res.status(404).json({ error: "Employee not found" });

  const date = parsed.data.date ? new Date(parsed.data.date) : new Date();
  const record = await upsertAttendance(req.auth!.tenantId, employee.id, date, parsed.data.status);
  res.status(201).json(record);
});
