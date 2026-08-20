# ERP Kernel Backend

Multi-tenant ERP kernel and API for Loyatek. This service is the foundation layer — authentication, tenant isolation, and role-based access — that every business module (Inventory, Procurement, Accounting, HR, CRM) is built on top of.

The frontend will reuse the existing Loyatek / ERP Kernel Showcase design, rebuilt in React and wired to this API in place of static mock data.

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Node.js + Express + TypeScript | Type-safe REST API, well suited to real-time integrations (WhatsApp, webhooks) planned for later phases |
| Database | PostgreSQL | Relational integrity for tightly coupled ERP data (invoices, stock, suppliers) with ACID transaction guarantees |
| ORM | Prisma | Type-safe queries and version-controlled schema migrations |
| Auth | JWT (short-lived access token + persisted refresh token) + bcrypt | Industry-standard, stateless authentication |
| Validation | Zod | Schema validation at the API boundary before business logic runs |

## Architecture

Every module follows the same pattern: a Prisma model, a `routes.ts`, and (where business logic warrants it) a `service.ts`, all passing through a shared middleware chain:

```
requireAuth → requireRole → validation → business logic → DB transaction
```

**Multi-tenancy** is enforced at the row level: every table carries a `tenantId`, and every query is scoped to the `tenantId` extracted from the caller's JWT. There is no code path that can return another tenant's data.

**Roles**: `OWNER` / `ADMIN` / `MANAGER` / `STAFF`, enforced per-route via a `requireRole(...)` middleware.

## Modules

### ✅ Core Kernel
- Tenant registration, login, refresh token rotation
- Role-based access control
- Multi-branch support per tenant

### ✅ Inventory
- Stock items scoped to tenant + branch
- Every stock change is recorded as an immutable `InventoryMovement` (`IN` / `OUT` / `ADJUSTMENT`) — not just a mutated counter
- Automatic low-stock detection (`lowStockAlert`) against a configurable reorder threshold, laying the groundwork for WhatsApp-based alerting in a later phase

### ✅ Procurement
- Suppliers, each with a lead time in days
- Purchase orders (`DRAFT` → `ORDERED` → `RECEIVED` / `CANCELLED`)
- Receiving a purchase order atomically increments stock **and** writes the corresponding `InventoryMovement` records in a single transaction — no manual reconciliation step
- RFQ comparison: request quotes from multiple suppliers for the same item (price, lead time, rating) and select a winning vendor
- Accounts Payable scheduler: real payable amounts computed from received purchase orders, with a 30-day due date set automatically on receipt, overdue detection, and a "mark paid" action

### ✅ Accounting
- Chart of accounts (`ASSET` / `LIABILITY` / `EQUITY` / `REVENUE` / `EXPENSE`)
- Double-entry journal entries — every entry is rejected outright unless total debit equals total credit
- Trial balance report computed from actual recorded entries, not manually aggregated figures
- Real customer invoicing with 5% VAT auto-calculated, a genuine ZATCA Phase 1-format QR code (Base64 TLV, scannable), and a sequential invoice number per tenant
- Issuing an invoice atomically creates the corresponding journal entry (Dr Accounts Receivable, Cr Sales Revenue, Cr VAT Payable) — invoicing and the general ledger are the same source of truth, not two disconnected systems
- One-click VAT report for any date range, computed from real issued invoices

### ✅ HR & Commission
- Employee records per branch, each with a commission rate, base salary, and monthly sales target
- Recording a sale atomically: deducts stock, writes the corresponding `InventoryMovement`, and computes commission from the employee's actual rate — all in one transaction
- Per-employee commission report built from real recorded sales, not manual estimates
- Weekly shift planner (AM/PM/Full/Off per day) and daily attendance tracking (On Shift/Break/Off/Absent)
- Attendance % computed from real scheduled shifts vs. actual attendance records for the current month — returns `null` (not a misleading 0%) when no shifts are scheduled yet
- "Actual" sales figure computed from real `Sale` records for the current calendar month, compared against the employee's `monthlyTarget`
- Simple payslip endpoint: base salary + this month's real commission total

### ✅ CRM
- Customer records, optionally linked to each `Sale`
- Purchase history and total spend per customer, computed from actual recorded sales — not a manually maintained figure
- B2B deal pipeline (`LEAD` → `QUALIFIED` → `PROPOSAL` → `WON` / `LOST`), advanced one stage at a time
- Unified per-customer activity timeline, auto-populated on every deal stage change, plus manual notes/calls/emails

### ✅ Business Intelligence (BI)
- Revenue trend for the last 30 days computed from real `Sale` records — deliberately **not** a predictive/AI forecast, since that would require a real forecasting model this project doesn't have; showing genuine historical data instead of a fabricated prediction
- Cross-branch performance heatmap (revenue, order count, low-stock count) computed live across every branch on the tenant — requires more than one branch to be meaningful

### ✅ Booking Engine
- Per-tenant booking settings: industry preset, brand name, services offered, opening/closing hours, per-hour enable/disable, slot duration, buffer gap, peak-slot flagging, WhatsApp confirmation template, resource allocation mode (staff vs. location), and theme color
- Bookable resources (staff or locations), created per branch
- **Real conflict prevention**: a database-level unique constraint on `(resourceId, date, hour)` makes double-booking impossible, not just discouraged by application logic
- Available-slots endpoint computes genuinely free times for a resource on a given day — open hours minus disabled hours minus already-booked hours
- Customer-facing booking creation, cancellation, and rescheduling
- Phone-based "My Bookings" lookup (no separate customer login system — customers look up their bookings by the WhatsApp number they booked with)
- Real stats: bookings this week, bookings today, and resource utilization % computed from actual booking density against configured capacity

### ✅ Wallet Loyalty Pass
- Per-tenant loyalty settings: mechanic (stamp / points / tier / cashback), point/stamp rules, expiration, card theme (RGB, layout, logo, center-circle branding), and program terms
- Real customer registry with a genuine points balance — adjusting a customer's balance persists immediately, and can't go below zero
- Unique phone number per tenant prevents duplicate loyalty accounts
- WhatsApp "notify" endpoint is a real API call that gets queued (no live WhatsApp Business API integration yet, so no message is actually delivered — this is flagged honestly rather than faked)

### ✅ Platform Signup, Subscriptions &amp; Super Admin
- `POST /api/auth/register` was already real from day one (creates a `Tenant` + its `OWNER` user) — the frontend now finally has a signup page that uses it
- Every `Tenant` has a real `subscribedModules` array (`erp`, `booking`, `wallet`, `whatsapp`, `catalog`) — new signups get all five by default since there's no billing integration yet, but a super admin can restrict any tenant to exactly what they're paying for
- Each protected page (ERP Kernel, Booking, Wallet, WhatsApp, Catalog) checks the logged-in tenant's `subscribedModules` and shows an honest "not included in your plan" screen instead of the module if it's missing
- A `User.isSuperAdmin` flag (off by default, never settable via signup) grants access to `/api/super-admin/*`: list every registered tenant with owner info and user/branch counts, and toggle which products each tenant can access
- No signup field or UI can grant super admin — it's promoted via `npm run make-super-admin -- <email>`, a one-time script you run yourself against an existing account

### ✅ Active Catalog & Order Engine
- Real per-tenant menu: categories and items with names, descriptions, prices, and photos (base64), fully CRUD
- Menu layout preference (list / grid / gallery / story) and order-mode settings (dine-in table count, pickup, prep time, merchant email, kitchen WhatsApp number) persist for real
- Placing an order is real: it re-reads each item's current price from the database (never trusts the price the frontend sends), snapshots the item name/price onto the order line, and computes the total server-side
- Orders are stored with mode (dine-in table number or pickup ready-time), customer info, and status — a real order history, not a simulated confirmation
- Every tenant gets a unique public `slug` (auto-generated from the company name, backfilled automatically for tenants created before this existed) — this powers a completely public, unauthenticated menu at `/api/public/menu/:slug/*`, so real customers scanning a table QR code never need an account or login

### ✅ Public Booking &amp; Loyalty Join Links
- The same slug-based public pattern now extends to Booking and Wallet: `/api/public/booking/:slug/*` lets a real customer see live availability and book a real slot with zero login, and `/api/public/wallet/:slug/join` lets a customer self-register for the loyalty program from a QR code on the counter
- All three public surfaces (menu, booking, loyalty join) share the same real backend logic as the authenticated merchant views — no separate "demo" data path

### ✅ Expanded Super Admin
- `GET /api/super-admin/tenants` now returns every user per company (not just the owner), real usage counts per product (bookings made, loyalty members, orders placed), and each tenant's public slug
- `PATCH /api/super-admin/users/:id/active` lets the platform owner disable or re-enable any user account across any company

### ✅ WhatsApp Automation — Real Foundation, Honest About Limits
Actually sending or receiving WhatsApp messages requires a real Meta WhatsApp Business API account (business verification, phone number, template approval) — that's an external prerequisite, not something a backend can fake. What's genuinely real here:
- **Bot Flow Builder**: flow steps (`BotFlowNode`) persist per tenant for real, ready to wire into a real send pipeline once Meta is connected
- **Unified Contacts**: a real contact list assembled by querying actual `WalletCustomer`, `Booking`, and `CatalogOrder` records and de-duplicating by phone — not a single fabricated number
- **Contact Notes**: real staff notes tied to a contact's phone number, persisted for real
- **Campaigns**: real draft records (name, segment description, template text) that persist — but `POST /api/whatsapp/campaigns/:id/send` honestly returns an error unless a real Meta access token and phone number ID have been saved via `PATCH /api/whatsapp/settings`, and even then returns 501 (not implemented) rather than pretending to deliver anything, since the actual Meta Cloud API call isn't wired up yet
- The frontend flags Voice/Podcast and Analytics tabs as illustrative-only, since those genuinely can't be real without live message data

### ✅ Real Subscriptions &amp; MyFatoorah Checkout
- New tenants now start with **zero** subscribed modules (previously all five were granted by default — that was a real bug, now fixed) — access is only ever granted by the platform owner after confirming payment
- `POST /api/checkout/orders` creates a real `SubscriptionOrder` and calls MyFatoorah's actual **v3** API (`POST /v3/payments`, the current Hosted Payment Page endpoint — v2 is deprecated and MyFatoorah's own docs say it "should not be used for new integrations") to generate a real hosted payment page — nothing is faked; if no MyFatoorah API key is configured yet, it says so plainly instead of pretending to succeed
- `GET /api/public/checkout/orders/:id/status` double-checks payment status directly against MyFatoorah's v3 `GET /v3/payments/{paymentId}` (Get Payment Details) rather than trusting anything the browser reports — the `paymentId` comes from MyFatoorah itself, appended to the redirect URL after payment
- Orders stay `PENDING` (or `PAID` once MyFatoorah confirms) until a super admin explicitly hits "Activate" — payment succeeding never auto-grants access, matching the requirement that a human confirms before turning services on
- `/api/platform-settings` (super admin only) stores the MyFatoorah API key for the whole platform (not per-tenant) — paste a real MyFatoorah test key here to make checkout actually work end-to-end

## Roadmap Status
Phase 2 (Procurement, Accounting, HR/Commission, CRM), Phase 3 (CRM Pipeline, Procurement RFQ/AP, Invoicing/VAT, BI), the real-data Booking Engine, Wallet Loyalty Pass, platform-level multi-tenant subscriptions/super admin, the Active Catalog & Order Engine (including a fully public customer-facing menu at `/menu/:slug`), and WhatsApp Automation's real foundation (bot flows, unified contacts, campaign drafts) are complete. The backend now supports a full operational loop: **supplier → RFQ → purchase order → stock in → sale → commission → invoice → VAT → journal entry → customer purchase history/deal pipeline**, plus a fully independent, conflict-safe **booking engine**, a real **loyalty pass system**, **per-tenant product access control**, a real **public menu/ordering system**, and a real (Meta-integration-ready) **WhatsApp automation foundation**, all backed by real transactional data.

Next up: the remaining ERP sub-modules (Operations, Assets, Budget, Fleet, Manufacturing, Support, Automation), and — whenever a real Meta WhatsApp Business API account is available — wiring the actual send/receive pipeline.

## Local Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 14+ (or Docker, if preferred)

### 1. Start PostgreSQL
Via Docker:
```bash
docker compose up -d
```
Or point `DATABASE_URL` in `.env` at an existing local PostgreSQL instance.

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
```bash
cp .env.example .env
```
Update `DATABASE_URL` with your PostgreSQL credentials.

### 4. Run migrations
```bash
npm run prisma:migrate
```

### 5. Start the server
```bash
npm run dev
```
The API will be available at `http://localhost:4000`.

## API Quick Reference

All endpoints except `/health`, `/api/auth/register`, and `/api/auth/login` require:
```
Authorization: Bearer <accessToken>
```

**Register a tenant (creates the first OWNER user):**
```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "Al Wakrah Retail Co",
    "industry": "RETAIL",
    "ownerName": "Ahmed",
    "email": "ahmed@example.com",
    "password": "SecurePass123"
  }'
```

**Create a branch:**
```bash
curl -X POST http://localhost:4000/api/tenants/branches \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Doha Central Warehouse"}'
```

**Create an inventory item:**
```bash
curl -X POST http://localhost:4000/api/inventory \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": "<branchId>",
    "name": "Wireless Earbuds Pro",
    "sku": "RT-1042",
    "quantity": 20,
    "reorderAt": 15,
    "costPrice": 45,
    "sellPrice": 89
  }'
```

**Record a sale (stock OUT):**
```bash
curl -X POST http://localhost:4000/api/inventory/<itemId>/movements \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"type": "OUT", "quantity": 6, "reason": "POS Sale #1042"}'
```
Returns `lowStockAlert: true` once quantity drops to or below `reorderAt`.

**Create a supplier:**
```bash
curl -X POST http://localhost:4000/api/suppliers \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Gulf Electronics Supplier", "phone": "+97444123456", "email": "sales@gulfelectronics.com"}'
```

**Create a purchase order:**
```bash
curl -X POST http://localhost:4000/api/purchase-orders \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "branchId": "<branchId>",
    "supplierId": "<supplierId>",
    "items": [{ "itemId": "<itemId>", "quantity": 30, "unitCost": 42 }]
  }'
```

**Receive a purchase order (updates stock automatically):**
```bash
curl -X POST http://localhost:4000/api/purchase-orders/<purchaseOrderId>/receive \
  -H "Authorization: Bearer <accessToken>"
```

## Contributing to This Codebase

New modules should follow the existing convention:
1. Add the Prisma model(s) to `schema.prisma`, scoped by `tenantId` (and `branchId` where applicable)
2. Add `<module>.routes.ts` under `src/modules/<module>/`, guarded by `requireAuth` and `requireRole`
3. Add `<module>.service.ts` for any logic beyond simple CRUD, particularly anything requiring a `$transaction`
4. Register the router in `src/app.ts`
