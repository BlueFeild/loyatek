import express from "express";
import cors from "cors";
import { authRouter } from "./modules/auth/auth.routes";
import { tenantsRouter } from "./modules/tenants/tenants.routes";
import { companiesRouter } from "./modules/tenants/companies.routes";
import { usersRouter } from "./modules/users/users.routes";
import { inventoryRouter } from "./modules/inventory/inventory.routes";
import { suppliersRouter } from "./modules/procurement/suppliers.routes";
import { purchaseOrdersRouter } from "./modules/procurement/purchase-orders.routes";
import { rfqRouter } from "./modules/procurement/rfq.routes";
import { accountsRouter } from "./modules/accounting/accounts.routes";
import { vendorBillsRouter } from "./modules/accounting/vendor-bills.routes";
import { journalRouter } from "./modules/accounting/journal.routes";
import { invoicesRouter } from "./modules/accounting/invoices.routes";
import { biRouter } from "./modules/bi/bi.routes";
import { resourcesRouter } from "./modules/booking/resources.routes";
import { bookingsRouter } from "./modules/booking/bookings.routes";
import { walletRouter } from "./modules/wallet/wallet.routes";
import { superAdminRouter } from "./modules/super-admin/super-admin.routes";
import { agencyRouter } from "./modules/agency/agency.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";
import { publicCatalogRouter } from "./modules/catalog/public-catalog.routes";
import { publicBookingRouter } from "./modules/booking/public-booking.routes";
import { publicWalletRouter } from "./modules/wallet/public-wallet.routes";
import { publicContactRouter } from "./modules/contact/public-contact.routes";
import { checkoutRouter } from "./modules/checkout/checkout.routes";
import { publicCheckoutRouter } from "./modules/checkout/public-checkout.routes";
import { platformSettingsRouter } from "./modules/platform-settings/platform-settings.routes";
import { opsRouter } from "./modules/operations/ops.routes";
import { assetsRouter } from "./modules/assets/assets.routes";
import { budgetRouter } from "./modules/budget/budget.routes";
import { fleetRouter } from "./modules/fleet/fleet.routes";
import { manufacturingRouter } from "./modules/manufacturing/manufacturing.routes";
import { supportRouter } from "./modules/support/support.routes";
import { automationRouter } from "./modules/automation/automation.routes";
import { linktreeRouter } from "./modules/linktree/linktree.routes";
import { publicLinktreeRouter } from "./modules/linktree/public-linktree.routes";
import { whatsappRouter } from "./modules/whatsapp/whatsapp.routes";
import { employeesRouter } from "./modules/hr/employees.routes";
import { salesRouter } from "./modules/hr/sales.routes";
import { customersRouter } from "./modules/crm/customers.routes";
import { dealsRouter } from "./modules/crm/deals.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { paymentSettingsRouter } from "./modules/payment-settings/payment-settings.routes";

export const app = express();

// CORS مقيّد لدومينات معروفة بس - مش أي موقع في العالم. لو محتاجة
// تضيفي دومين جديد (زي دومين مخصّص لعميل)، ضيفيه في متغير البيئة
// ALLOWED_ORIGINS (مفصول بفاصلة) بدل ما تفتحيه للجميع
const defaultOrigins = ["http://localhost:5173", "http://localhost:4173"];
const envOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const allowedOrigins = [...defaultOrigins, ...envOrigins];

app.use(
  cors({
    origin(origin, callback) {
      // مفيش origin (زي نداءات Server-to-Server أو Postman) بنسمحلها -
      // القيد هنا خاص بطلبات المتصفح بس
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  })
);
// حد أعلى مرفوع عشان يستوعب الصور المرفوعة كـ base64 (لوجو، صور أصناف، غلاف فئات...)
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// كل موديول جديد (Accounting, HR, CRM, Procurement...) هيتضاف هنا
// بنفس النمط: router منفصل + requireAuth + requireRole حسب الحاجة
app.use("/api/auth", authRouter);
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenants/companies", companiesRouter);
app.use("/api/users", usersRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/purchase-orders", purchaseOrdersRouter);
app.use("/api/rfqs", rfqRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/vendor-bills", vendorBillsRouter);
app.use("/api/journal-entries", journalRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/bi", biRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/super-admin", superAdminRouter);
app.use("/api/agency", agencyRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/public/menu", publicCatalogRouter);
app.use("/api/public/booking", publicBookingRouter);
app.use("/api/public/wallet", publicWalletRouter);
app.use("/api/public/contact", publicContactRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/public/checkout", publicCheckoutRouter);
app.use("/api/platform-settings", platformSettingsRouter);
app.use("/api/ops", opsRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/budget", budgetRouter);
app.use("/api/fleet", fleetRouter);
app.use("/api/manufacturing", manufacturingRouter);
app.use("/api/support", supportRouter);
app.use("/api/automation", automationRouter);
app.use("/api/linktree", linktreeRouter);
app.use("/api/public/linktree", publicLinktreeRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/sales", salesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/payment-settings", paymentSettingsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});
