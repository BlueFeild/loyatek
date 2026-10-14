import "dotenv/config";
import { app } from "./app";
import { startBookingReminderScheduler } from "./jobs/booking-reminders";

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`ERP Kernel backend running on http://localhost:${PORT}`);
  // تذكير واتساب قبل مواعيد الحجز (كل 5 دقايق) - DISABLE_REMINDERS=1 يقفله
  startBookingReminderScheduler(Number(process.env.REMINDER_INTERVAL_MS) || undefined);
});
