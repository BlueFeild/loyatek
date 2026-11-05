import { PrismaClient } from "@prisma/client";
import type { AgentBookingInfo, AgentBookingRequest } from "../ai/agent-types";
import { createBooking, getOrCreateSettings } from "../booking/bookings.service";
import { hasPricedServices, computeBookingAmount } from "../booking/service-pricing";
import { getTenantPaymentMethods } from "../checkout/myfatoorah";
import { confirmsOnOrder } from "../payment-settings/payment-methods";
import { calendarDateKey, parseCalendarDate, todayKeyInTimezone } from "../../utils/calendarDate";
import { isModuleLive } from "../../utils/platform-config";

// الموظف الذكي يحجز بنفسه من محادثة واتساب: المواعيد الفاضية الحقيقية + إنشاء الحجز
// بنفس createBooking بتاع صفحة الحجز (نفس التحقق، نفس رسايل التأكيد، نفس منع التعارض)

export const AGENT_BOOKING_DAYS = 7;

export type AgentBookResult = { ok: true; bookingId: string; confirmationSent: boolean } | { ok: false; error: string };

export interface AgentBooker {
  // null = الشركة مش مشتركة في الحجز / مفيش موارد ← مفيش حجز من المحادثة
  info(tenantId: string, now: Date): Promise<AgentBookingInfo | null>;
  book(tenantId: string, req: AgentBookingRequest & { phone: string }, now: Date): Promise<AgentBookResult>;
}

// الساعة دلوقتي بتوقيت البيزنس (0-23)
export function hourInTimezone(timezone: string, now: Date): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now)) % 24;
  } catch {
    return now.getUTCHours();
  }
}

// الأيام الجاية بالساعات الفاضية (ساعة فاضية = فيه مورد واحد على الأقل من غير حجز)
export function freeDays(input: {
  todayKey: string;
  currentHour: number;
  openHour: number;
  closeHour: number;
  disabledHours: number[];
  resourceIds: string[];
  taken: { resourceId: string; dateKey: string; hour: number }[];
  days?: number;
}): AgentBookingInfo["days"] {
  const start = parseCalendarDate(input.todayKey);
  if (!start || !input.resourceIds.length) return [];
  const disabled = new Set(input.disabledHours);
  const busy = new Set(input.taken.map((t) => `${t.resourceId}|${t.dateKey}|${t.hour}`));
  const out: AgentBookingInfo["days"] = [];
  for (let i = 0; i < (input.days ?? AGENT_BOOKING_DAYS); i++) {
    const day = new Date(start.getTime() + i * 86400_000);
    const key = calendarDateKey(day);
    const hours: number[] = [];
    for (let h = input.openHour; h < input.closeHour; h++) {
      if (disabled.has(h)) continue;
      if (i === 0 && h <= input.currentHour) continue;
      if (input.resourceIds.some((r) => !busy.has(`${r}|${key}|${h}`))) hours.push(h);
    }
    out.push({ date: key, weekday: day.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }), hours });
  }
  return out;
}

// أسماء الخدمات اللي الموظف كتبها ← الأسماء المحفوظة بالظبط (من غير فرق حروف كبيرة/مسافات)
export function matchServices(asked: string[], services: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const byName = new Map(services.map((s) => [norm(s), s]));
  return Array.from(new Set(asked.map((a) => byName.get(norm(a))).filter((s): s is string => Boolean(s))));
}

export class PrismaAgentBooker implements AgentBooker {
  constructor(private readonly db: PrismaClient) {}

  private async load(tenantId: string, now: Date) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !(await isModuleLive(tenant, "booking"))) return null;
    const resources = await this.db.resource.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { id: true, branchId: true } });
    if (!resources.length) return null;
    const settings = await getOrCreateSettings(tenantId);
    const timezone = settings.timezone || "Asia/Qatar";
    const todayKey = todayKeyInTimezone(timezone, now);
    const from = parseCalendarDate(todayKey)!;
    const to = new Date(from.getTime() + (AGENT_BOOKING_DAYS - 1) * 86400_000);
    const bookings = await this.db.booking.findMany({
      where: { tenantId, date: { gte: from, lte: to }, status: { not: "CANCELLED" } },
      select: { resourceId: true, date: true, hour: true },
    });
    const taken = bookings.map((b) => ({ resourceId: b.resourceId, dateKey: calendarDateKey(b.date), hour: b.hour }));
    const days = freeDays({ todayKey, currentHour: hourInTimezone(timezone, now), openHour: settings.openHour, closeHour: settings.closeHour, disabledHours: settings.disabledHours, resourceIds: resources.map((r) => r.id), taken });

    // الحجز من المحادثة: مجاني، أو فيه طريقة دفع كاش (بتأكد الحجز على طول)
    const pricedServices = hasPricedServices(settings.servicePrices, settings.services);
    const paymentPossible = settings.paymentRequired && (pricedServices || Number(settings.paymentAmount) > 0);
    let cashMethodId: string | null = null;
    if (paymentPossible) cashMethodId = (await getTenantPaymentMethods(tenantId)).find((m) => confirmsOnOrder(m.type))?.id ?? null;
    const canBookInChat = !paymentPossible || cashMethodId !== null;
    return { resources, settings, taken, days, cashMethodId, info: { canBookInChat, needsService: settings.paymentRequired && pricedServices, days } satisfies AgentBookingInfo };
  }

  async info(tenantId: string, now: Date) {
    return (await this.load(tenantId, now))?.info ?? null;
  }

  async book(tenantId: string, req: AgentBookingRequest & { phone: string }, now: Date): Promise<AgentBookResult> {
    const ctx = await this.load(tenantId, now);
    if (!ctx || !ctx.info.canBookInChat) return { ok: false, error: "booking_not_possible" };
    const day = ctx.days.find((d) => d.date === req.date);
    if (!day || !day.hours.includes(req.hour)) return { ok: false, error: "slot_not_free" };
    const services = matchServices(req.services, ctx.settings.services);
    if (ctx.info.needsService && !computeBookingAmount(ctx.settings, services).services.length) return { ok: false, error: "service_needed" };
    const busy = new Set(ctx.taken.filter((t) => t.dateKey === req.date && t.hour === req.hour).map((t) => t.resourceId));
    const resource = ctx.resources.find((r) => !busy.has(r.id));
    if (!resource) return { ok: false, error: "slot_not_free" };
    const digits = req.phone.replace(/[^\d]/g, "");
    try {
      const booking = await createBooking({
        tenantId,
        branchId: resource.branchId,
        resourceId: resource.id,
        customerName: req.name.trim().length >= 2 ? req.name.trim() : "WhatsApp customer",
        customerPhone: `+${digits}`,
        date: req.date,
        hour: req.hour,
        note: "Booked on WhatsApp by the AI assistant",
        services,
        paymentMethodId: ctx.cashMethodId ?? undefined,
      });
      return { ok: true, bookingId: booking.id, confirmationSent: Boolean(booking.whatsappConfirmationSent) };
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      return { ok: false, error: /just booked/i.test(msg) ? "slot_not_free" : msg || "booking_failed" };
    }
  }
}
