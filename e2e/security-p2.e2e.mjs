// اختبارات رجوع لإصلاحات P2 من التدقيق الأمني 2026-11-23 - سيرفر + Postgres محليين بس (ممنوع على الإنتاج).
//   API=http://localhost:4320 DATABASE_URL=postgresql://... node e2e/security-p2.e2e.mjs
// كل بند: مسموح (المفروض ينجح) + ممنوع (المفروض يترفض)، والبنود اللي فيها سباق بتتبعت في نفس اللحظة.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const API = process.env.API ?? "http://localhost:4320";
if (/railway\.app|blue-field\.co|rlwy/.test(API + (process.env.DATABASE_URL ?? ""))) throw new Error("Refusing to run against production");
const db = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(extra)?.slice(0, 600)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipN = 1;
const freshIp = () => `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
async function call(m, u, b, t, ip = freshIp()) {
  const r = await fetch(API + u, { method: m, headers: { "Content-Type": "application/json", "X-Real-IP": ip, ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text();
  let d;
  try {
    d = JSON.parse(x);
  } catch {
    d = x;
  }
  return { s: r.status, d };
}
const tag = Date.now().toString(36);
const far = () => new Date(Date.now() + 30 * 864e5).toISOString();
async function company(name, modules) {
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${tag}@example.test`;
  const reg = await call("POST", "/api/auth/register", { companyName: `${name} ${tag}`, industry: "HOSPITALITY", ownerName: "Owner " + name, email, password: "LocalPass123" });
  if (reg.s !== 201) throw new Error("register failed " + JSON.stringify(reg));
  const me = (await call("GET", "/api/tenants/me", null, reg.d.accessToken)).d;
  await db.tenant.update({ where: { id: me.id }, data: { subscribedModules: modules, moduleExpirations: Object.fromEntries(modules.map((m) => [m, far()])), trialExpiresAt: null, isPlatformOwner: false } });
  const branchId = (await call("GET", "/api/tenants/branches", null, reg.d.accessToken)).d[0].id;
  return { t: reg.d.accessToken, id: me.id, slug: me.slug, email, branchId, ownerName: "Owner " + name };
}
async function member(co, role, name) {
  const email = `${name.toLowerCase()}-${role.toLowerCase()}-${tag}@example.test`;
  const add = await call("POST", "/api/users/team", { name, email, role, password: "LocalPass123", branchId: co.branchId }, co.t);
  if (add.s !== 201) throw new Error("team add failed " + JSON.stringify(add));
  const login = await call("POST", "/api/auth/login", { email, password: "LocalPass123" });
  if (login.s !== 200) throw new Error("login failed " + JSON.stringify(login));
  const user = await db.user.findFirst({ where: { email } });
  return { t: login.d.accessToken, id: user.id, email };
}

const ALL = ["erp", "booking", "linktree", "wallet", "catalog", "whatsapp", "store", "tickets", "social", "sms"];
const A = await company("Romeo Co", ALL);
const B = await company("Sierra Co", ALL);
const NOERP = await company("Tango Co", ["booking"]);
const staff = await member(A, "STAFF", "Sam");
const manager = await member(A, "MANAGER", "Mona");

// ---------- DATA-004: البيع من نفس الفرع + إلغاء البيع ----------
{
  const b2 = (await call("POST", "/api/tenants/branches", { name: "Second branch" }, A.t)).d;
  const item1 = (await call("POST", "/api/inventory", { branchId: A.branchId, name: "Latte", sku: "LAT-" + tag, quantity: 20, costPrice: 1, sellPrice: 5 }, A.t)).d;
  const item2 = (await call("POST", "/api/inventory", { branchId: b2.id, name: "Mocha", sku: "MOC-" + tag, quantity: 20, costPrice: 1, sellPrice: 6 }, A.t)).d;
  const emp = (await call("POST", "/api/employees", { branchId: A.branchId, name: "Seller One", position: "Barista" }, A.t)).d;
  const emp2 = (await call("POST", "/api/employees", { branchId: A.branchId, name: "Seller Two", position: "Barista", userId: staff.id }, A.t)).d;
  const wrongBranch = await call("POST", "/api/sales", { branchId: A.branchId, employeeId: emp.id, itemId: item2.id, quantity: 1 }, A.t);
  check("DATA-004 selling an item of another branch is refused", wrongBranch.s === 400, wrongBranch);
  const sale = await call("POST", "/api/sales", { branchId: A.branchId, employeeId: emp.id, itemId: item1.id, quantity: 3 }, A.t);
  check("DATA-004 selling an item of the same branch works (authorized)", sale.s === 201, sale);
  const asOther = await call("POST", "/api/sales", { branchId: A.branchId, employeeId: emp.id, itemId: item1.id, quantity: 1 }, staff.t);
  check("DATA-004 STAFF can't record a sale under someone else's name", asOther.s === 400, asOther);
  const asSelf = await call("POST", "/api/sales", { branchId: A.branchId, employeeId: emp2.id, itemId: item1.id, quantity: 1 }, staff.t);
  check("DATA-004 STAFF records a sale under their own name (authorized)", asSelf.s === 201, asSelf);
  const staffVoid = await call("POST", `/api/sales/${sale.d.id}/void`, {}, staff.t);
  check("DATA-004 STAFF can't cancel a sale", staffVoid.s === 403, staffVoid.s);
  const foreignVoid = await call("POST", `/api/sales/${sale.d.id}/void`, {}, B.t);
  check("DATA-004 another company can't cancel the sale", foreignVoid.s === 404, foreignVoid.s);
  const voids = await Promise.all(Array.from({ length: 5 }, () => call("POST", `/api/sales/${sale.d.id}/void`, {}, A.t)));
  const ok = voids.filter((v) => v.s === 200).length;
  const stock = (await db.inventoryItem.findUnique({ where: { id: item1.id } })).quantity;
  const entry = sale.d.journalEntryId ? await db.journalEntry.findUnique({ where: { id: sale.d.journalEntryId } }) : null;
  check("DATA-004 5 cancels at once → 1 succeeds, stock back once (20-3-1+3 = 19), entry removed", ok === 1 && stock === 19 && !entry, { ok, stock, entry: !!entry });
  // PERF-001: صفحة الفريق لسه بترجّع الأرقام (المبيعات الفعلية) بعد ما بقت استعلامات مجمّعة
  const emps = (await call("GET", "/api/employees", null, A.t)).d;
  const two = emps.find((e) => e.id === emp2.id);
  check("PERF-001 team list still shows this month's sales per person", two && Number(two.actual) === 5 && "attendancePct" in two, two);
  const staffView = (await call("GET", "/api/employees", null, staff.t)).d.find((e) => e.id === emp2.id);
  check("PERF-001 STAFF still doesn't see salaries", staffView && !("baseSalary" in staffView) && !("target" in staffView), staffView);
}

// ---------- ERP-09 / 10 / 11 / 13 / 14 ----------
{
  const accs = (await call("GET", "/api/accounts", null, A.t)).d;
  const cash = accs.find((a) => a.code === "1000") ?? accs[0];
  const other = accs.find((a) => a.id !== cash.id);
  const both = await call("POST", "/api/journal-entries", { description: "Bad entry", lines: [{ accountId: cash.id, debit: 5, credit: 5 }, { accountId: other.id, debit: 5, credit: 5 }] }, A.t);
  const zero = await call("POST", "/api/journal-entries", { description: "Zero entry", lines: [{ accountId: cash.id, debit: 0 }, { accountId: other.id, credit: 0 }] }, A.t);
  const good = await call("POST", "/api/journal-entries", { description: "Good entry", lines: [{ accountId: cash.id, debit: 0.1 }, { accountId: cash.id, debit: 0.2 }, { accountId: other.id, credit: 0.3 }] }, A.t);
  check("ERP-09 a line with debit AND credit is refused", both.s === 400, both);
  check("ERP-09 0/0 lines are refused", zero.s === 400, zero);
  check("ERP-09 a balanced entry (0.1+0.2 = 0.3) is accepted (authorized)", good.s === 201, good);

  const cust = (await call("POST", "/api/customers", { name: "Invoice Customer", phone: "+97455507777" }, A.t)).d;
  const inv = () => call("POST", "/api/invoices", { branchId: A.branchId, customerId: cust.id, items: [{ description: "Service", quantity: 1, unitPrice: 10 }] }, A.t);
  const many = await Promise.all(Array.from({ length: 6 }, inv));
  const nums = many.filter((r) => r.s === 201).map((r) => r.d.invoiceNumber);
  check("ERP-10 6 invoices at once → all created with different numbers", nums.length === 6 && new Set(nums).size === 6, many.map((r) => r.s + ":" + (r.d.invoiceNumber ?? r.d.error)));
  await db.invoice.delete({ where: { id: many[0].d.id } }).catch(() => {});
  const after = await inv();
  check("ERP-10 deleting a draft doesn't make the next number repeat", after.s === 201 && !nums.slice(1).includes(after.d.invoiceNumber), after.d.invoiceNumber);

  const b2 = (await db.branch.findMany({ where: { tenantId: A.id }, orderBy: { createdAt: "asc" } }))[1];
  const sup = (await call("POST", "/api/suppliers", { name: "Bean Supplier" }, A.t)).d;
  const mocha = await db.inventoryItem.findFirst({ where: { tenantId: A.id, branchId: b2.id } });
  const latte = await db.inventoryItem.findFirst({ where: { tenantId: A.id, branchId: A.branchId } });
  const badPo = await call("POST", "/api/purchase-orders", { branchId: A.branchId, supplierId: sup.id, items: [{ itemId: mocha.id, quantity: 5, unitCost: 1 }] }, A.t);
  const goodPo = await call("POST", "/api/purchase-orders", { branchId: A.branchId, supplierId: sup.id, items: [{ itemId: latte.id, quantity: 5, unitCost: 1 }] }, A.t);
  check("ERP-11 a supplier order with another branch's item is refused", badPo.s === 400, badPo);
  check("ERP-11 a supplier order with this branch's item works (authorized)", goodPo.s === 201, goodPo);

  const sumOwner = await call("GET", "/api/tenants/branches/summary", null, A.t);
  const sumStaff = await call("GET", "/api/tenants/branches/summary", null, staff.t);
  const sumNoErp = await call("GET", "/api/tenants/branches/summary", null, NOERP.t);
  check("ERP-13 branch money summary: owner 200, STAFF 403, company without ERP 403", sumOwner.s === 200 && sumStaff.s === 403 && sumNoErp.s === 403, [sumOwner.s, sumStaff.s, sumNoErp.s]);

  const dupSku = await call("POST", "/api/inventory", { branchId: A.branchId, name: "Latte again", sku: "LAT-" + tag, quantity: 1, costPrice: 1, sellPrice: 2 }, A.t);
  const badDate = await call("POST", "/api/inventory", { branchId: A.branchId, name: "Milk", sku: "MLK-" + tag, quantity: 1, costPrice: 1, sellPrice: 2, expiryDate: "not-a-date" }, A.t);
  check("ERP-14 duplicate SKU → 409 with a clear message (not 500)", dupSku.s === 409 && /already exists/i.test(dupSku.d.error), dupSku);
  check("ERP-14 invalid date → 400 (not 500)", badDate.s === 400, badDate);
}

// ---------- ERP-12: مهام التشغيل وتذاكر الدعم ----------
{
  const task = (await call("POST", "/api/ops/tasks", { title: "Clean the machine", priority: "LOW" }, A.t)).d;
  const rename = await call("PATCH", `/api/ops/tasks/${task.id}`, { title: "Hacked" }, staff.t);
  const status = await call("PATCH", `/api/ops/tasks/${task.id}`, { status: "IN_PROGRESS" }, staff.t);
  check("ERP-12 STAFF can't edit a task's details", rename.s === 403, rename.s);
  check("ERP-12 STAFF can move an unassigned task forward (authorized)", status.s === 200, status);
  const otherEmp = await db.employee.findFirst({ where: { tenantId: A.id, userId: null } });
  const assigned = (await call("POST", "/api/ops/tasks", { title: "Count stock", assigneeId: otherEmp.id }, A.t)).d;
  const notMine = await call("PATCH", `/api/ops/tasks/${assigned.id}`, { status: "DONE" }, staff.t);
  check("ERP-12 STAFF can't change someone else's task", notMine.s === 403, notMine.s);

  const cust = await db.customer.findFirst({ where: { tenantId: A.id } });
  const ticket = (await call("POST", "/api/support/tickets", { customerId: cust.id, subject: "Late order", priority: "LOW" }, A.t)).d;
  const reply = await call("POST", `/api/support/tickets/${ticket.id}/replies`, { authorName: "The Owner (fake)", message: "We're on it" }, staff.t);
  check("ERP-12 reply author comes from the account, not from what was sent", reply.s === 201 && reply.d.authorName === "Sam", reply.d);
  const prio = await call("PATCH", `/api/support/tickets/${ticket.id}`, { priority: "URGENT" }, staff.t);
  const prioMgr = await call("PATCH", `/api/support/tickets/${ticket.id}`, { priority: "URGENT" }, manager.t);
  check("ERP-12 ticket priority: STAFF 403, manager 200", prio.s === 403 && prioMgr.s === 200, [prio.s, prioMgr.s]);
}

// ---------- AUTH-07: الدور من قاعدة البيانات ----------
{
  const before = await call("GET", "/api/vendor-bills", null, manager.t);
  await db.user.update({ where: { id: manager.id }, data: { role: "STAFF" } });
  await sleep(10_500);
  const createBill = await call("POST", "/api/tenants/branches", { name: "Should fail" }, manager.t);
  const team = await call("POST", "/api/users/team", { name: "X", email: `x-${tag}@example.test`, role: "STAFF", password: "LocalPass123" }, manager.t);
  check("AUTH-07 a manager demoted to STAFF loses manager actions within ~10 s (same token)", before.s === 200 && createBill.s === 403 && team.s === 403, [before.s, createBill.s, team.s]);

  const gone = await member(A, "STAFF", "Gina");
  await db.user.delete({ where: { id: gone.id } });
  await sleep(10_500);
  const ghost = await call("GET", "/api/tenants/me", null, gone.t);
  check("AUTH-07 a deleted user's token stops working", ghost.s === 401, ghost);

  const saEmail = `sa-${tag}@example.test`;
  await call("POST", "/api/users/team", { name: "Tmp Admin", email: saEmail, role: "ADMIN", password: "LocalPass123" }, A.t);
  await db.user.update({ where: { email: saEmail }, data: { isSuperAdmin: true } }).catch(async () => {
    const u = await db.user.findFirst({ where: { email: saEmail } });
    await db.user.update({ where: { id: u.id }, data: { isSuperAdmin: true } });
  });
  const saLogin = await call("POST", "/api/auth/login", { email: saEmail, password: "LocalPass123" });
  const saOk = await call("GET", "/api/super-admin/tenants", null, saLogin.d.accessToken);
  const manage = await call("POST", `/api/super-admin/tenants/${B.id}/impersonate`, {}, saLogin.d.accessToken);
  const u = await db.user.findFirst({ where: { email: saEmail } });
  await db.user.update({ where: { id: u.id }, data: { isSuperAdmin: false } });
  await sleep(10_500);
  const saNow = await call("GET", "/api/super-admin/tenants", null, saLogin.d.accessToken);
  const manageNow = await call("GET", "/api/tenants/me", null, manage.d.accessToken);
  check("AUTH-07 super admin removed → super admin pages 403 with the old token", saOk.s === 200 && saNow.s === 403, [saOk.s, saNow.s]);
  check("AUTH-07 super admin removed → their 'manage this company' token stops too", manage.s === 200 && manageNow.s === 401, [manage.s, manageNow.s]);
}

// ---------- PAY-01: رقم الدفعة لطلب واحد بس + رد الحالة العام مختصر ----------
{
  const mk = () => db.subscriptionOrder.create({ data: { tenantId: A.id, selectedModules: ["erp"], amount: 29, myFatoorahPaymentUrl: "https://pay.example/secret-link", myFatoorahInvoiceId: "INV-" + Math.random() } });
  const o1 = await mk();
  const o2 = await mk();
  await db.subscriptionOrder.update({ where: { id: o1.id }, data: { myFatoorahPaymentId: "PAY-" + tag } });
  let clash = false;
  try {
    await db.subscriptionOrder.update({ where: { id: o2.id }, data: { myFatoorahPaymentId: "PAY-" + tag } });
  } catch (e) {
    clash = e.code === "P2002";
  }
  check("PAY-01 the same gateway payment can't be saved on two orders (unique index)", clash, clash);
  const st = await call("GET", `/api/public/checkout/orders/${o2.id}/status`);
  check("PAY-01/SEC-005 public order status has the status only (no payment links / invoice ids)", st.s === 200 && st.d.status === "PENDING" && !("myFatoorahPaymentUrl" in st.d) && !("myFatoorahInvoiceId" in st.d) && !("tenantId" in st.d), st.d);
  await db.subscriptionOrder.deleteMany({ where: { id: { in: [o1.id, o2.id] } } });
}

// ---------- COM-09 / 11 / 10 / 14 ----------
{
  const res = (await call("POST", "/api/resources", { branchId: A.branchId, name: "Dr Lina", type: "STAFF" }, A.t)).d;
  const date = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const bk = await call("POST", `/api/public/booking/${A.slug}/bookings`, { resourceId: res.id, customerName: "Private Person", customerPhone: "+97455512345", customerEmail: "private@example.test", date, hour: 12 });
  const st = await call("GET", `/api/public/booking/${A.slug}/bookings/${bk.d.id}/payment-status`);
  check("COM-09 public booking status: no phone / email / notes, confirmation fields kept", st.s === 200 && !("customerPhone" in st.d) && !("customerEmail" in st.d) && st.d.hour === 12 && st.d.resource?.name === "Dr Lina", st.d);

  await call("PUT", "/api/payment-settings/methods", { methods: [{ type: "LINK", label: "Pay online", url: "https://pay.example/link?amount={amount}" }, { type: "BANK_TRANSFER", label: "Bank", details: "IBAN QA00 TEST" }] }, A.t);
  const ps = (await call("GET", "/api/payment-settings", null, staff.t)).d;
  const psOwner = (await call("GET", "/api/payment-settings", null, A.t)).d;
  const staffHasUrl = JSON.stringify(ps).includes("pay.example");
  check("COM-11 STAFF sees payment methods without the payment links", !staffHasUrl && ps.methods?.length === 2, ps);
  check("COM-11 owner still sees the payment link (authorized)", JSON.stringify(psOwner).includes("pay.example"), psOwner.methods);
  const csvStaff = await call("GET", `/api/seats/events/00000000-0000-4000-8000-000000000000/orders.csv`, null, staff.t);
  const csvOwner = await call("GET", `/api/seats/events/00000000-0000-4000-8000-000000000000/orders.csv`, null, A.t);
  check("COM-11 ticket buyers CSV: STAFF 403, owner passes the role check (404 for a missing show)", csvStaff.s === 403 && csvOwner.s === 404, [csvStaff.s, csvOwner.s]);

  const fakeOrder = "00000000-0000-4000-8000-000000000001";
  const cancelStaff = await call("PATCH", `/api/store/orders/${fakeOrder}`, { status: "CANCELLED" }, staff.t);
  const shipStaff = await call("PATCH", `/api/store/orders/${fakeOrder}`, { status: "SHIPPED" }, staff.t);
  check("COM-10 STAFF can't cancel a store order, but can update other statuses (404 = passed the check)", cancelStaff.s === 403 && shipStaff.s === 404, [cancelStaff.s, shipStaff.s]);

  const svg = "data:image/svg+xml;base64," + Buffer.from("<svg onload='alert(1)'/>").toString("base64");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const badLogo = await call("PATCH", "/api/bookings/settings", { logoDataUrl: svg }, A.t);
  const goodLogo = await call("PATCH", "/api/bookings/settings", { logoDataUrl: png }, A.t);
  const badWallet = await call("PATCH", "/api/wallet/settings", { decorCircles: [{ label: "x", image: "javascript:alert(1)" }] }, A.t);
  check("COM-14 SVG logo is refused, PNG accepted", badLogo.s === 400 && goodLogo.s === 200, [badLogo.s, goodLogo.s, badLogo.d]);
  check("COM-14 wallet decor image must be a real image", badWallet.s === 400, badWallet.s);
}

// ---------- COM-12: حد ملفات Link-in-Bio تحت ضغط ----------
{
  await call("GET", "/api/linktree/settings", null, A.t);
  const file = (i) => call("POST", "/api/linktree/links/file", { label: "Menu " + i, fileName: `menu-${i}.txt`, mimeType: "text/plain", dataBase64: Buffer.from("hello " + i).toString("base64") }, A.t);
  for (let i = 0; i < 8; i++) await file(i);
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => file(100 + i)));
  const files = await db.linktreeLink.count({ where: { tenantId: A.id, kind: "FILE" } });
  check("COM-12 6 uploads at once with 2 places left → exactly 10 files", files === 10 && burst.filter((r) => r.s === 201).length === 2, { files, st: burst.map((r) => r.s) });
}

// ---------- MSG-06 / 08 / 09 / 10 / 12 / 13 ----------
{
  const phoneId = "77" + Date.now().toString().slice(-9);
  const conA = await call("PATCH", "/api/whatsapp/settings", { metaAccessToken: "EAAG-test-token-A", metaPhoneNumberId: phoneId }, A.t);
  check("MSG-06 first company connects its number (authorized)", conA.s === 200 && conA.d.isConnected === true, conA.d);
  const rawTok = (await db.$queryRaw`SELECT "metaAccessToken" FROM whatsapp_settings WHERE "tenantId" = ${A.id}`)[0].metaAccessToken;
  check("MSG-08 the WhatsApp token is stored encrypted (not the plain text)", rawTok.startsWith("v1:") && !rawTok.includes("EAAG-test-token-A"), rawTok.slice(0, 12));
  const verify = await call("POST", "/api/whatsapp/verify", {}, A.t);
  check("MSG-08 the encrypted token still works with Meta (verify ok)", verify.s === 200 && verify.d.isConnected === true, verify.d);
  const conB = await call("PATCH", "/api/whatsapp/settings", { metaAccessToken: "EAAG-test-token-B", metaPhoneNumberId: phoneId }, B.t);
  check("MSG-06 a second company can't connect the same number", conB.s === 200 && conB.d.isConnected === false && /another BlueField company/.test(conB.d.lastVerifyError ?? ""), conB.d);

  const sOwner = (await call("GET", "/api/whatsapp/settings", null, A.t)).d;
  const sStaff = (await call("GET", "/api/whatsapp/settings", null, staff.t)).d;
  check("MSG-09 webhook link + verify token: owner sees them, STAFF doesn't", !!sOwner.webhookVerifyToken && sStaff.webhookVerifyToken === null && sStaff.webhookUrl === null, { owner: !!sOwner.webhookVerifyToken, staff: sStaff.webhookVerifyToken });
  const rOwner = (await call("GET", "/api/social/report/settings", null, A.t)).d;
  const rStaff = (await call("GET", "/api/social/report/settings", null, staff.t)).d;
  check("MSG-09 social report share link: owner sees it, STAFF doesn't", !!rOwner.shareToken && rStaff.shareToken === null, { owner: !!rOwner.shareToken, staff: rStaff.shareToken });

  await db.whatsappContact.create({ data: { tenantId: A.id, phone: "97455598765", name: "Stopped", optedOut: true, source: "inbound" } });
  const tpl = await call("POST", "/api/whatsapp/conversations/97455598765/template", { templateId: "hello_world", params: [] }, A.t);
  const tplOk = await call("POST", "/api/whatsapp/conversations/97455598766/template", { templateId: "hello_world", params: [] }, A.t);
  check("MSG-10 template to a customer who sent STOP is refused", tpl.s === 409 && tpl.d.code === "OPTED_OUT", tpl);
  check("MSG-10 template to a normal customer still goes (authorized)", tplOk.s < 300, tplOk);

  const selfSender = await call("PATCH", "/api/sms/settings", { senderName: "QNB" }, A.t);
  const saEmail = `sa2-${tag}@example.test`;
  await call("POST", "/api/users/team", { name: "Tmp SA", email: saEmail, role: "ADMIN", password: "LocalPass123" }, B.t);
  const saUser = await db.user.findFirst({ where: { email: saEmail } });
  await db.user.update({ where: { id: saUser.id }, data: { isSuperAdmin: true } });
  const sa = (await call("POST", "/api/auth/login", { email: saEmail, password: "LocalPass123" })).d.accessToken;
  const saSender = await call("PATCH", `/api/super-admin/sms/${A.id}/sender`, { senderName: "RomeoCo" }, sa);
  const merchantPatchAdmin = await call("PATCH", `/api/super-admin/sms/${A.id}/sender`, { senderName: "QNB" }, A.t);
  check("MSG-12 a company can't set its own SMS sender name", selfSender.s === 403, selfSender);
  check("MSG-12 super admin sets it (authorized); merchants can't use the admin route", saSender.s === 200 && saSender.d.senderName === "RomeoCo" && merchantPatchAdmin.s === 403, [saSender.s, saSender.d?.senderName, merchantPatchAdmin.s]);

  const path = "/p2-track-" + tag;
  const ip = "10.77.250.250";
  for (let i = 0; i < 65; i++) await call("POST", "/api/analytics/track", { path }, null, ip);
  const views = await db.platformEvent.count({ where: { path } });
  check("MSG-13 one device can count at most 60 page views per 10 min", views === 60, views);

  // SA-01: اسم شركة بصيغة Excel في ملف الفواتير
  await db.tenant.update({ where: { id: B.id }, data: { name: '=HYPERLINK("http://evil.example","x")' } });
  await db.subscriptionOrder.create({ data: { tenantId: B.id, selectedModules: ["erp"], amount: 1, status: "PAID" } });
  const csv = await fetch(API + "/api/super-admin/orders/export.csv", { headers: { Authorization: "Bearer " + sa } }).then((r) => r.text());
  check("SA-01 a company name that looks like a formula is neutralised in the CSV", csv.includes(`"'=HYPERLINK(`) && !csv.includes(`,=HYPERLINK(`), csv.split("\n").find((l) => l.includes("HYPERLINK")));
  await db.user.update({ where: { id: saUser.id }, data: { isSuperAdmin: false } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.$disconnect();
process.exit(fail ? 1 : 0);
