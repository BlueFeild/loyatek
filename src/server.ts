import "dotenv/config";
import { app } from "./app";
import { startBookingReminderScheduler } from "./jobs/booking-reminders";
import { startExchangeRateScheduler } from "./utils/money";
import { startPaymentSyncScheduler } from "./jobs/payment-sync";

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`ERP Kernel backend running on http://localhost:${PORT}`);
  // تذكير واتساب قبل مواعيد الحجز (كل 5 دقايق) - DISABLE_REMINDERS=1 يقفله
  startBookingReminderScheduler(Number(process.env.REMINDER_INTERVAL_MS) || undefined);
  // أسعار الصرف من الإنترنت كل 12 ساعة - DISABLE_RATE_REFRESH=1 يقفلها
  startExchangeRateScheduler();
  // طلبات الاشتراك اللي اتدفعت بتتفعّل لوحدها (بنسأل MyFatoorah برقم الفاتورة كل دقيقتين)
  startPaymentSyncScheduler(Number(process.env.PAYMENT_SYNC_INTERVAL_MS) || undefined);
});
