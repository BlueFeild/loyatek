// اختبارات الـ jobs لإصلاحات P2 (تدقيق 2026-11-23) على Postgres محلي حقيقي - ممنوع على الإنتاج:
//  - COM-02: حجوزات الدفع الأونلاين اللي ماتدفعتش بتتلغي، والميعاد يرجع متاح (من غير ما نلغي حجز البوابة مارديتش عنه)
//  - MSG-05: حملات واتساب/SMS المجدولة لشركة موقوفة ماتتبعتش
// التشغيل (من backend/):
//   DATABASE_URL=postgresql://... TS_NODE_TRANSPILE_ONLY=1 npx ts-node e2e/p2-jobs.e2e.ts
process.env.MYFATOORAH_BASE_URL = "http://127.0.0.1:9"; // بوابة "مش بترد" عشان نختبر إن الحجز مايتلغيش
process.env.DISABLE_BOOKING_PAYMENT_EXPIRY = "1";
import { PrismaClient } from "@prisma/client";
import { expireUnpaidBookings } from "../src/modules/booking/bookings.service";
import { PrismaCampaignRepository } from "../src/modules/whatsapp/campaign.repository";
import { PrismaSmsStore } from "../src/modules/sms/sms.repository";

if (/railway|rlwy|blue-field/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against production");
const db = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(extra)}`);
};

async function main() {
  const tag = Date.now().toString(36);
  const mkTenant = (name: string) =>
    db.tenant.create({ data: { name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, industry: "HOSPITALITY", subscribedModules: ["booking"] } as never });
  const open = await mkTenant("Jobs Open");
  const paused = await mkTenant("Jobs Paused");
  await db.tenant.update({ where: { id: paused.id }, data: { accountStatus: "SUSPENDED" } as never });
  const branch = await db.branch.create({ data: { tenantId: open.id, name: "Main" } });
  const resource = await db.resource.create({ data: { tenantId: open.id, branchId: branch.id, name: "Room 1", type: "LOCATION" } as never });
  const date = new Date(Date.UTC(2030, 0, 15));
  const old = new Date(Date.now() - 2 * 3600_000);
  const mk = (hour: number, paymentMethodType: string, extra: Record<string, unknown> = {}) =>
    db.booking.create({
      data: { tenantId: open.id, branchId: branch.id, resourceId: resource.id, customerName: "Job Test", customerPhone: "+97455500000", date, hour, paymentStatus: "AWAITING_PAYMENT", amount: 10, paymentMethodType, createdAt: old, ...extra } as never,
    });

  // ---- COM-02 ----
  const skipNoPay = await mk(9, "SKIPCASH");
  const mfNoKey = await mk(10, "MYFATOORAH", { myFatoorahInvoiceId: "111" });
  const fresh = await mk(11, "SKIPCASH", { createdAt: new Date() });
  const bank = await mk(12, "BANK_TRANSFER");
  const results = await Promise.all([expireUnpaidBookings(), expireUnpaidBookings()]);
  const st = async (id: string) => (await db.booking.findUnique({ where: { id } }))!.status;
  check("COM-02 unpaid SkipCash booking after the hold → cancelled", (await st(skipNoPay.id)) === "CANCELLED");
  check("COM-02 MyFatoorah booking whose merchant has no key → cancelled", (await st(mfNoKey.id)) === "CANCELLED");
  check("COM-02 booking still inside the hold (10 min) → kept", (await st(fresh.id)) !== "CANCELLED");
  check("COM-02 bank transfer is never auto-cancelled (merchant confirms)", (await st(bank.id)) !== "CANCELLED");
  const total = results.reduce((s, r) => s + r.expired, 0);
  check("COM-02 two job runs at the same time cancel each booking once", total === 2, results);
  const again = await db.booking.create({ data: { tenantId: open.id, branchId: branch.id, resourceId: resource.id, customerName: "New", customerPhone: "+97455500001", date, hour: 9 } as never }).then(() => true, () => false);
  check("COM-02 the expired time can be booked again", again);

  await db.tenantPaymentSettings.upsert({ where: { tenantId: open.id }, create: { tenantId: open.id, myFatoorahApiKey: "local-test-key" } as never, update: { myFatoorahApiKey: "local-test-key" } as never });
  const mfDown = await mk(13, "MYFATOORAH", { myFatoorahInvoiceId: "222" });
  await expireUnpaidBookings();
  check("COM-02 gateway not answering → booking is NOT cancelled (try again next run)", (await st(mfDown.id)) !== "CANCELLED");

  // ---- MSG-05 ----
  const past = new Date(Date.now() - 60_000);
  const waOpen = await db.whatsappCampaign.create({ data: { tenantId: open.id, name: "Open co", segmentDesc: "-", templateText: "hi", status: "SCHEDULED", scheduledAt: past } as never });
  const waPaused = await db.whatsappCampaign.create({ data: { tenantId: paused.id, name: "Paused co", segmentDesc: "-", templateText: "hi", status: "SCHEDULED", scheduledAt: past } as never });
  const due = (await new PrismaCampaignRepository(db).dueScheduled(new Date(), 500)).map((d) => d.id);
  check("MSG-05 WhatsApp: due campaign of an open company is picked", due.includes(waOpen.id));
  check("MSG-05 WhatsApp: due campaign of a paused company is NOT sent", !due.includes(waPaused.id));
  const smsOpen = await db.smsCampaign.create({ data: { tenantId: open.id, name: "Open", body: "x", status: "SCHEDULED", scheduledAt: past } as never });
  const smsPaused = await db.smsCampaign.create({ data: { tenantId: paused.id, name: "Paused", body: "x", status: "SCHEDULED", scheduledAt: past } as never });
  const smsDue = (await new PrismaSmsStore().dueCampaigns(new Date(), 500)).map((d) => d.id);
  check("MSG-05 SMS: open company's campaign is picked, paused company's is not", smsDue.includes(smsOpen.id) && !smsDue.includes(smsPaused.id), smsDue.length);

  await db.whatsappCampaign.deleteMany({ where: { id: { in: [waOpen.id, waPaused.id] } } });
  await db.smsCampaign.deleteMany({ where: { id: { in: [smsOpen.id, smsPaused.id] } } });
  await db.tenant.deleteMany({ where: { id: { in: [open.id, paused.id] } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
