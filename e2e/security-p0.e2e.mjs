// اختبارات رجوع (regression) لإصلاحات P0 من التدقيق الأمني 2026-11-23.
// بتشتغل على سيرفر + Postgres محليين بس - ممنوع تتشغّل على الإنتاج (بتعمل شركات وتعدّل بيانات).
//   API=http://localhost:4310 DATABASE_URL=postgresql://... node e2e/security-p0.e2e.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const API = process.env.API ?? "http://localhost:4310";
if (/railway\.app|blue-field\.co/.test(API + (process.env.DATABASE_URL ?? ""))) throw new Error("Refusing to run against production");
const db = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(extra)}`);
};
// كل طلب بـ IP وهمي مختلف (X-Real-IP) عشان حد الدخول ما يأثرش على باقي الاختبارات، إلا لو حددنا IP
let ipN = 1;
const freshIp = () => `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
async function call(m, u, b, t, ip = freshIp()) {
  const r = await fetch(API + u, {
    method: m,
    headers: { "Content-Type": "application/json", "X-Real-IP": ip, ...(t ? { Authorization: "Bearer " + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
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
async function company(name, modules = ["erp", "booking"]) {
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${tag}@example.test`;
  const reg = await call("POST", "/api/auth/register", { companyName: `${name} ${tag}`, industry: "HOSPITALITY", ownerName: "Owner " + name, email, password: "LocalPass123" });
  if (reg.s !== 201) throw new Error("register failed " + JSON.stringify(reg));
  const me = (await call("GET", "/api/tenants/me", null, reg.d.accessToken)).d;
  await db.tenant.update({ where: { id: me.id }, data: { subscribedModules: modules, isPlatformOwner: true } });
  const branchId = (await call("GET", "/api/tenants/branches", null, reg.d.accessToken)).d[0].id;
  return { t: reg.d.accessToken, id: me.id, slug: me.slug, email, branchId };
}
const noInternals = (d) => !/prisma|invocation|\\src\\|\/src\//i.test(JSON.stringify(d ?? ""));

const A = await company("Alpha Co");
const B = await company("Beta Co");
const item = async (c, q) =>
  (await call("POST", "/api/inventory", { branchId: c.branchId, name: "Item", sku: "S" + Math.random().toString(36).slice(2, 8), quantity: q, costPrice: 1, sellPrice: 2 }, c.t)).d;
const qty = async (id) => (await db.inventoryItem.findUnique({ where: { id } })).quantity;

// ---- DATA-002: كمية سالبة / صفر ----
{
  const it = await item(A, 10);
  const neg = await call("POST", `/api/inventory/${it.id}/movements`, { type: "OUT", quantity: -100 }, A.t);
  check("DATA-002 OUT with negative quantity is refused", neg.s === 400 && (await qty(it.id)) === 10, { s: neg.s, q: await qty(it.id) });
  const zero = await call("POST", `/api/inventory/${it.id}/movements`, { type: "ADJUSTMENT", quantity: 0 }, A.t);
  check("DATA-002 ADJUSTMENT 0 is refused", zero.s === 400, zero.s);
  const adj = await call("POST", `/api/inventory/${it.id}/movements`, { type: "ADJUSTMENT", quantity: -2 }, A.t);
  check("DATA-002 ADJUSTMENT -2 still works (authorized)", adj.s === 201 && (await qty(it.id)) === 8, { s: adj.s, q: await qty(it.id) });
  const over = await call("POST", `/api/inventory/${it.id}/movements`, { type: "OUT", quantity: 9 }, A.t);
  check("DATA-002 OUT more than stock is refused", over.s === 400 && (await qty(it.id)) === 8, over.s);
  const foreign = await call("POST", `/api/inventory/${it.id}/movements`, { type: "OUT", quantity: 1 }, B.t);
  check("DATA-002 other company can't move this stock", foreign.s === 404 && (await qty(it.id)) === 8, foreign.s);
}

// ---- DATA-001: سباق الصرف ----
{
  let bad = 0;
  for (let i = 0; i < 10; i++) {
    const it = await item(A, 10);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call("POST", `/api/inventory/${it.id}/movements`, { type: "OUT", quantity: 7 }, A.t)));
    const ok = rs.filter((r) => r.s === 201).length;
    const moves = await db.inventoryMovement.count({ where: { itemId: it.id } });
    if (ok !== 1 || (await qty(it.id)) !== 3 || moves !== 1) bad++;
  }
  check("DATA-001 4 concurrent OUT 7 from 10 → exactly one succeeds (10 rounds)", bad === 0, { bad });
  const it = await item(A, 0);
  await Promise.all(Array.from({ length: 10 }, () => call("POST", `/api/inventory/${it.id}/movements`, { type: "IN", quantity: 5 }, A.t)));
  check("DATA-001 10 concurrent IN 5 → 50 (no lost update)", (await qty(it.id)) === 50, await qty(it.id));
}

// ---- ERP-03: إصدار الفاتورة مرة واحدة ----
{
  await call("PATCH", "/api/tenants/vat-number", { vatNumber: "300000000000003" }, A.t);
  const cust = (await call("POST", "/api/customers", { name: "Cara Customer" }, A.t)).d;
  const inv = (await call("POST", "/api/invoices", { branchId: A.branchId, customerId: cust.id, items: [{ description: "Svc", quantity: 1, unitPrice: 100 }] }, A.t)).d;
  const before = await db.journalEntry.count({ where: { tenantId: A.id } });
  const rs = await Promise.all(Array.from({ length: 6 }, () => call("POST", `/api/invoices/${inv.id}/issue`, {}, A.t)));
  const after = await db.journalEntry.count({ where: { tenantId: A.id } });
  check("ERP-03 6 concurrent issues → 1 success + 1 journal entry", rs.filter((r) => r.s === 200).length === 1 && after - before === 1, { st: rs.map((r) => r.s), entries: after - before });
  check("ERP-03 refused issues don't leak database internals", rs.filter((r) => r.s !== 200).every((r) => noInternals(r.d)), rs.map((r) => r.d));
  const foreign = await call("POST", `/api/invoices/${inv.id}/issue`, {}, B.t);
  check("ERP-03 other company can't issue it", foreign.s >= 400 && (await db.journalEntry.count({ where: { tenantId: A.id } })) === after, foreign.s);
}

// ---- ERP-04: استلام أمر الشراء مرة واحدة ----
{
  const it = await item(A, 0);
  const sup = (await call("POST", "/api/suppliers", { name: "Sam Supplier" }, A.t)).d;
  const po = (await call("POST", "/api/purchase-orders", { branchId: A.branchId, supplierId: sup.id, items: [{ itemId: it.id, quantity: 10, unitCost: 1 }] }, A.t)).d;
  await call("POST", `/api/purchase-orders/${po.id}/status`, { status: "ORDERED" }, A.t);
  const foreign = await call("POST", `/api/purchase-orders/${po.id}/receive`, {}, B.t);
  check("ERP-04 other company can't receive it", foreign.s >= 400 && (await qty(it.id)) === 0, foreign.s);
  const rs = await Promise.all(Array.from({ length: 6 }, () => call("POST", `/api/purchase-orders/${po.id}/receive`, {}, A.t)));
  const moves = await db.inventoryMovement.count({ where: { itemId: it.id } });
  check("ERP-04 6 concurrent receives → stock 10, one movement", rs.filter((r) => r.s === 200).length === 1 && (await qty(it.id)) === 10 && moves === 1, {
    st: rs.map((r) => r.s),
    q: await qty(it.id),
    moves,
  });
}

// ---- ERP-08: تعديل فاتورة المورد في نفس اللحظة ----
{
  const created = await call("POST", "/api/vendor-bills", { vendorName: "Vic Vendor", amount: 50, paid: true }, A.t);
  const billId = created.d.id ?? created.d.bill?.id;
  const rs = await Promise.all([60, 70, 80, 90, 100].map((amount) => call("PATCH", `/api/vendor-bills/${billId}`, { amount }, A.t)));
  const row = await db.vendorBill.findUnique({ where: { id: billId } });
  const all = await db.journalEntry.findMany({ where: { tenantId: A.id, description: { contains: "Vic Vendor" } } });
  const orphans = all.filter((e) => e.id !== row.journalEntryId && e.id !== row.paymentJournalEntryId);
  check("ERP-08 5 concurrent bill edits → no orphan journal entries", created.s === 201 && rs.every((r) => r.s === 200) && orphans.length === 0 && all.length === 2, {
    created: created.s,
    st: rs.map((r) => r.s),
    entries: all.length,
    orphans: orphans.length,
  });
}

// ---- COM-01: بحث الحجوزات بالتليفون اتقفل ----
{
  const res = (await call("POST", "/api/resources", { branchId: A.branchId, name: "Dr Dana", type: "STAFF" }, A.t)).d;
  const date = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const b = await call("POST", `/api/public/booking/${A.slug}/bookings`, { resourceId: res.id, customerName: "Private Patient", customerPhone: "+97455501234", customerEmail: "patient@example.test", date, hour: 11, note: "sensitive note" });
  const leak = await call("GET", `/api/public/booking/${A.slug}/my-bookings?phone=55501234`);
  check("COM-01 public phone lookup returns nothing", b.s === 201 && leak.s === 410 && !JSON.stringify(leak.d).includes("Private Patient"), { book: b.s, s: leak.s });
  const own = await call("GET", "/api/bookings", null, A.t);
  check("COM-01 merchant still sees the booking (authorized)", own.s === 200 && JSON.stringify(own.d).includes("Private Patient"), own.s);
}

// ---- AUTH-04: POST /api/users القديم ----
{
  const add = (body, t) => call("POST", "/api/users", { password: "LocalPass123", ...body }, t);
  const adm = await add({ name: "Ada Admin", email: `ada-${tag}@example.test`, role: "ADMIN" }, A.t);
  check("AUTH-04 owner can add an admin (authorized)", adm.s === 201, adm);
  const admLogin = await call("POST", "/api/auth/login", { email: `ada-${tag}@example.test`, password: "LocalPass123" });
  const adm2 = await add({ name: "Eve Admin", email: `eve-${tag}@example.test`, role: "ADMIN" }, admLogin.d.accessToken);
  check("AUTH-04 admin can't create another admin", adm2.s === 403, adm2);
  const staff = await add({ name: "Stan Staff", email: `stan-${tag}@example.test`, role: "STAFF" }, admLogin.d.accessToken);
  check("AUTH-04 admin can still add staff (authorized)", staff.s === 201, staff);
  const dup = await add({ name: "Bob Copy", email: B.email.toUpperCase(), role: "STAFF" }, A.t);
  check("AUTH-04 another company's email (any case) is refused", dup.s === 409, dup);
  const bLogin = await call("POST", "/api/auth/login", { email: B.email, password: "LocalPass123" });
  const bMe = await call("GET", "/api/tenants/me", null, bLogin.d.accessToken);
  check("AUTH-04 victim still logs into their own company", bLogin.s === 200 && bMe.d.id === B.id, { s: bLogin.s });
}

// ---- AUTH-01: نقل الملكية مرة واحدة ----
{
  const C = await company("Gamma Co");
  const r1 = await call("POST", "/api/account/transfer-ownership", { email: `new1-${tag}@example.test`, name: "New One", currentPassword: "LocalPass123" }, C.t);
  const r2 = await call("POST", "/api/account/transfer-ownership", { email: `new2-${tag}@example.test`, name: "New Two", currentPassword: "LocalPass123" }, C.t);
  const owners = await db.user.count({ where: { tenantId: C.id, role: "OWNER" } });
  check("AUTH-01 transfer works once, the old token can't transfer again", r1.s === 200 && r2.s >= 400 && owners === 1, { r1: r1.s, r2: r2.s, owners });
  const D = await company("Delta Co");
  const rs = await Promise.all(
    [1, 2, 3, 4].map((i) => call("POST", "/api/account/transfer-ownership", { email: `race${i}-${tag}@example.test`, name: "Race " + i, currentPassword: "LocalPass123" }, D.t))
  );
  const dOwners = await db.user.count({ where: { tenantId: D.id, role: "OWNER" } });
  check("AUTH-01 4 concurrent transfers → exactly one owner", dOwners === 1 && rs.filter((r) => r.s === 200).length === 1, { st: rs.map((r) => r.s), dOwners });
}

// ---- AUTH-02 / AUTH-03: جلسة "إدارة نيابةً" ----
{
  const sa = await company("Sigma Admin");
  await db.user.updateMany({ where: { tenantId: sa.id }, data: { isSuperAdmin: true } });
  const saLogin = (await call("POST", "/api/auth/login", { email: sa.email, password: "LocalPass123" })).d.accessToken;
  // صاحب شركة E عنده شركة إضافية F مربوطة بيه
  const E = await company("Echo Co");
  const ownerE = await db.user.findFirst({ where: { tenantId: E.id, role: "OWNER" } });
  const F = await company("Foxtrot Co");
  const ownerF = await db.user.findFirst({ where: { tenantId: F.id, role: "OWNER" } });
  await db.user.update({ where: { id: ownerF.id }, data: { isLinkedCompany: true } });
  await db.companyMembership.create({ data: { ownerUserId: ownerE.id, tenantId: F.id, memberUserId: ownerF.id } });
  const own = await call("POST", `/api/tenants/companies/${F.id}/switch`, {}, E.t);
  check("AUTH-02 the owner can still switch to their own company (authorized)", own.s === 200, own.s);
  const manage = await call("POST", `/api/super-admin/tenants/${E.id}/impersonate`, {}, saLogin);
  check("AUTH-02 super admin got a manage token", manage.s === 200, manage.s);
  const sw = await call("POST", `/api/tenants/companies/${F.id}/switch`, {}, manage.d.accessToken);
  check("AUTH-02 manage token can't switch into the owner's other companies", sw.s === 403, sw.s);
  await db.user.update({ where: { id: ownerE.id }, data: { passwordHash: null, googleId: "g-" + tag } });
  const pw = await call("POST", "/api/account/password", { newPassword: "Attacker123!" }, manage.d.accessToken);
  const em = await call("PATCH", "/api/account/email", { newEmail: `taken-${tag}@example.test` }, manage.d.accessToken);
  const tr = await call("POST", "/api/account/transfer-ownership", { email: `steal-${tag}@example.test` }, manage.d.accessToken);
  const after = await db.user.findUnique({ where: { id: ownerE.id } });
  check(
    "AUTH-03 manage session can't set password / change email / transfer",
    pw.s === 403 && em.s === 403 && tr.s === 403 && after.passwordHash === null && after.email === ownerE.email && after.role === "OWNER",
    { pw: pw.s, em: em.s, tr: tr.s }
  );
  const read = await call("GET", "/api/account", null, manage.d.accessToken);
  check("AUTH-03 manage session can still read the account page", read.s === 200, read.s);
}

// ---- SEC-001: حدود محاولات الدخول ----
{
  const sts = [];
  for (let i = 0; i < 11; i++) sts.push((await call("POST", "/api/auth/login", { email: A.email, password: "wrong-" + i })).s);
  const right = await call("POST", "/api/auth/login", { email: A.email, password: "LocalPass123" });
  check("SEC-001 11th wrong password for one email → 429, even from new IPs", sts.slice(0, 10).every((s) => s === 401) && sts[10] === 429 && right.s === 429, { sts, right: right.s });
  const G = await company("Golf Co");
  const ip = "10.99.1.1";
  const ok1 = await call("POST", "/api/auth/login", { email: G.email, password: "LocalPass123" }, null, ip);
  const burst = [];
  for (let i = 0; i < 65; i++) burst.push((await call("POST", "/api/auth/login", { email: `nobody${i}-${tag}@example.test`, password: "x" }, null, ip)).s);
  check("SEC-001 one IP gets 429 after 60 auth requests", ok1.s === 200 && burst.indexOf(429) === 59 && burst.slice(59).every((s) => s === 429), { first429: burst.indexOf(429) });
  const other = await call("POST", "/api/auth/login", { email: G.email, password: "LocalPass123" }, null, "10.99.1.2");
  check("SEC-001 a different IP can still log in", other.s === 200, other.s);
}

// ---- SEC-003 (جزء): X-Powered-By ----
{
  const r = await fetch(API + "/health");
  check("SEC-003 X-Powered-By header removed", !r.headers.get("x-powered-by"), r.headers.get("x-powered-by"));
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.$disconnect();
process.exit(fail ? 1 : 0);
