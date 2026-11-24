import "dotenv/config";
import { app } from "./app";
import { startBookingReminderScheduler } from "./jobs/booking-reminders";
import { startExchangeRateScheduler } from "./utils/money";
import { startPaymentSyncScheduler } from "./jobs/payment-sync";
import { startSocialPublisherScheduler } from "./jobs/social-publisher";
import { startSocialReportScheduler } from "./jobs/social-reports";
import { startCampaignScheduler } from "./jobs/campaign-scheduler";
import { startSeatReminderScheduler } from "./jobs/seat-reminders";
import { startWhatsappSequenceScheduler } from "./jobs/whatsapp-sequences";
import { startSmsScheduler } from "./jobs/sms-scheduler";
import { startBookingPaymentExpiryScheduler } from "./jobs/booking-payment-expiry";
import { prisma, sealLegacyWhatsappSecrets } from "./config/db";
import { isShuttingDown, markShuttingDown } from "./utils/shutdown";

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  console.log(`ERP Kernel backend running on http://localhost:${PORT}`);
  // توكنات واتساب القديمة (نص عادي) تتشفّر مرة واحدة (تدقيق MSG-08). بعد دقيقتين - وقت النشر النسخة
  // القديمة بتفضل شغالة ثواني ومابتعرفش تفك التشفير، فنستنى لحد ما تقفل
  setTimeout(() => {
    sealLegacyWhatsappSecrets()
      .then((n) => n && console.log(`[db] encrypted ${n} stored WhatsApp secrets`))
      .catch((err) => console.warn(`[db] encrypting stored WhatsApp secrets failed: ${(err as Error).message}`));
  }, Number(process.env.SEAL_SECRETS_DELAY_MS) || 120_000).unref();
  // تذكير واتساب قبل مواعيد الحجز (كل 5 دقايق) - DISABLE_REMINDERS=1 يقفله
  startBookingReminderScheduler(Number(process.env.REMINDER_INTERVAL_MS) || undefined);
  // أسعار الصرف من الإنترنت كل 12 ساعة - DISABLE_RATE_REFRESH=1 يقفلها
  startExchangeRateScheduler();
  // طلبات الاشتراك اللي اتدفعت بتتفعّل لوحدها (بنسأل MyFatoorah برقم الفاتورة كل دقيقتين)
  startPaymentSyncScheduler(Number(process.env.PAYMENT_SYNC_INTERVAL_MS) || undefined);
  startSocialPublisherScheduler(Number(process.env.SOCIAL_PUBLISH_INTERVAL_MS) || undefined);
  startSocialReportScheduler(Number(process.env.SOCIAL_REPORT_INTERVAL_MS) || undefined);
  // حملات واتساب المجدولة (كل دقيقة)
  startCampaignScheduler(Number(process.env.CAMPAIGN_SCHEDULER_INTERVAL_MS) || undefined);
  // تذكير واتساب/إيميل قبل العروض (خدمة التذاكر)
  startSeatReminderScheduler(Number(process.env.SEAT_REMINDER_INTERVAL_MS) || undefined);
  // سلاسل رسايل واتساب (Drip) كل دقيقة - DISABLE_WHATSAPP_SEQUENCES=1 يقفلها
  startWhatsappSequenceScheduler(Number(process.env.SEQUENCE_INTERVAL_MS) || undefined);
  // حملات SMS المجدولة (كل دقيقة) - DISABLE_SMS_SCHEDULER=1 يقفلها
  startSmsScheduler(Number(process.env.SMS_SCHEDULER_INTERVAL_MS) || undefined);
  // حجوزات الدفع الأونلاين اللي ماتدفعتش في ساعة بتتلغي (الميعاد يرجع متاح)
  startBookingPaymentExpiryScheduler(Number(process.env.BOOKING_PAYMENT_EXPIRY_INTERVAL_MS) || undefined);
});

// إيقاف هادي (تدقيق INFRA-003): Railway بيبعت SIGTERM قبل ما يقفل النسخة القديمة.
// نبطّل طلبات جديدة، نستنى اللي شغال (لحد SHUTDOWN_GRACE_MS، افتراضي 20 ثانية)،
// الـ jobs ماتبدأش دورة جديدة، وبعدين نقفل قاعدة البيانات ونخرج
function shutdown(signal: string) {
  if (isShuttingDown()) return;
  markShuttingDown();
  console.log(`[server] ${signal} received — finishing open requests before stopping`);
  const graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 20_000;
  let done = false;
  const finish = async (reason: string) => {
    if (done) return;
    done = true;
    console.log(`[server] stopping (${reason})`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  server.close(() => void finish("all requests finished"));
  // الاتصالات الفاضية (keep-alive) تتقفل فورًا عشان close مايستناهاش
  server.closeIdleConnections?.();
  setTimeout(() => void finish("grace period ended"), graceMs).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
