import express from "express";
import cors from "cors";
import { authRouter } from "./modules/auth/auth.routes";
import { tenantsRouter } from "./modules/tenants/tenants.routes";
import { usersRouter } from "./modules/users/users.routes";
import { inventoryRouter } from "./modules/inventory/inventory.routes";
import { suppliersRouter } from "./modules/procurement/suppliers.routes";
import { purchaseOrdersRouter } from "./modules/procurement/purchase-orders.routes";
import { rfqRouter } from "./modules/procurement/rfq.routes";
import { accountsRouter } from "./modules/accounting/accounts.routes";
import { journalRouter } from "./modules/accounting/journal.routes";
import { invoicesRouter } from "./modules/accounting/invoices.routes";
import { biRouter } from "./modules/bi/bi.routes";
import { resourcesRouter } from "./modules/booking/resources.routes";
import { bookingsRouter } from "./modules/booking/bookings.routes";
import { walletRouter } from "./modules/wallet/wallet.routes";
import { superAdminRouter } from "./modules/super-admin/super-admin.routes";
import { catalogRouter } from "./modules/catalog/catalog.routes";
import { publicCatalogRouter } from "./modules/catalog/public-catalog.routes";
import { publicBookingRouter } from "./modules/booking/public-booking.routes";
import { publicWalletRouter } from "./modules/wallet/public-wallet.routes";
import { publicContactRouter } from "./modules/contact/public-contact.routes";
import { checkoutRouter } from "./modules/checkout/checkout.routes";
import { publicCheckoutRouter } from "./modules/checkout/public-checkout.routes";
import { platformSettingsRouter } from "./modules/platform-settings/platform-settings.routes";
import { whatsappRouter } from "./modules/whatsapp/whatsapp.routes";
import { employeesRouter } from "./modules/hr/employees.routes";
import { salesRouter } from "./modules/hr/sales.routes";
import { customersRouter } from "./modules/crm/customers.routes";
import { dealsRouter } from "./modules/crm/deals.routes";

export const app = express();

app.use(cors());
// حد أعلى مرفوع عشان يستوعب الصور المرفوعة كـ base64 (لوجو، صور أصناف، غلاف فئات...)
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// كل موديول جديد (Accounting, HR, CRM, Procurement...) هيتضاف هنا
// بنفس النمط: router منفصل + requireAuth + requireRole حسب الحاجة
app.use("/api/auth", authRouter);
app.use("/api/tenants", tenantsRouter);
app.use("/api/users", usersRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/purchase-orders", purchaseOrdersRouter);
app.use("/api/rfqs", rfqRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/journal-entries", journalRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/bi", biRouter);
app.use("/api/resources", resourcesRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/super-admin", superAdminRouter);
app.use("/api/catalog", catalogRouter);
app.use("/api/public/menu", publicCatalogRouter);
app.use("/api/public/booking", publicBookingRouter);
app.use("/api/public/wallet", publicWalletRouter);
app.use("/api/public/contact", publicContactRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/public/checkout", publicCheckoutRouter);
app.use("/api/platform-settings", platformSettingsRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/sales", salesRouter);
app.use("/api/customers", customersRouter);
app.use("/api/deals", dealsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});
