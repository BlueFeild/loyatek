// اختبارات رجوع لإصلاحات P1 من التدقيق الأمني 2026-11-23 - سيرفر + Postgres محليين بس.
//   API=http://localhost:4310 DATABASE_URL=postgresql://... node e2e/security-p1.e2e.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const API = process.env.API ?? "http://localhost:4310";
if (/railway\.app|blue-field\.co|rlwy/.test(API + (process.env.DATABASE_URL ?? ""))) throw new Error("Refusing to run against production");
const db = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(extra)}`);
};
let ipN = 1;
const freshIp = () => `10.88.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
async function raw(m, u, b, t, ip = freshIp()) {
  return fetch(API + u, { method: m, headers: { "Content-Type": "application/json", "X-Real-IP": ip, ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
}
async function call(m, u, b, t, ip) {
  const r = await raw(m, u, b, t, ip);
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
async function company(name, modules) {
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${tag}@example.test`;
  const reg = await call("POST", "/api/auth/register", { companyName: `${name} ${tag}`, industry: "HOSPITALITY", ownerName: "Owner " + name, email, password: "LocalPass123" });
  if (reg.s !== 201) throw new Error("register failed " + JSON.stringify(reg));
  const me = (await call("GET", "/api/tenants/me", null, reg.d.accessToken)).d;
  // اشتراك حقيقي (مش platform owner) عشان نختبر بوابة الخدمات فعلًا
  const far = new Date(Date.now() + 30 * 864e5).toISOString();
  await db.tenant.update({ where: { id: me.id }, data: { subscribedModules: modules, moduleExpirations: Object.fromEntries(modules.map((m) => [m, far])), trialExpiresAt: null, isPlatformOwner: false } });
  const branchId = (await call("GET", "/api/tenants/branches", null, reg.d.accessToken)).d[0].id;
  return { t: reg.d.accessToken, refresh: reg.d.refreshToken, id: me.id, slug: me.slug, email, branchId };
}

const A = await company("Papa Co", ["erp", "booking", "linktree", "wallet", "catalog", "whatsapp"]);
const NB = await company("Quebec Co", ["booking"]);

// ---- MSG-04: واتساب CRM محتاج اشتراك ----
{
  const crm = await call("GET", "/api/whatsapp/campaigns", null, NB.t);
  const conn = await call("GET", "/api/whatsapp/settings", null, NB.t);
  const tpl = await call("GET", "/api/whatsapp/booking-templates", null, NB.t);
  check("MSG-04 company without WhatsApp CRM can't use campaigns", crm.s === 403, crm.s);
  check("MSG-04 it can still connect its number + booking templates (authorized)", conn.s === 200 && tpl.s !== 403, { conn: conn.s, tpl: tpl.s });
  const own = await call("GET", "/api/whatsapp/campaigns", null, A.t);
  check("MSG-04 subscribed company still opens campaigns (authorized)", own.s === 200, own.s);
}

// ---- COM-02: الحجز العام ----
{
  const res = (await call("POST", "/api/resources", { branchId: A.branchId, name: "Dr Dana", type: "STAFF" }, A.t)).d;
  const date = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  const book = (hour, ip) => call("POST", `/api/public/booking/${A.slug}/bookings`, { resourceId: res.id, customerName: "Nora Customer", customerPhone: "+97455501111", date, hour }, null, ip);
  const night = await book(3);
  check("COM-02 booking at 3am (outside working hours) is refused", night.s === 400, night);
  const first = await book(11);
  check("COM-02 booking inside working hours works (authorized)", first.s === 201, first);
  const cancel = await call("PATCH", `/api/bookings/${first.d.id}/cancel`, {}, A.t);
  const cancel2 = cancel.s < 300 ? cancel : await call("POST", `/api/bookings/${first.d.id}/cancel`, {}, A.t);
  const again = await book(11);
  check("COM-02 a cancelled time can be booked again", cancel2.s < 300 && again.s === 201, { cancel: cancel2.s, again: again.s, d: again.d });
  const dup = await book(11);
  check("COM-02 the same live time still can't be booked twice", dup.s >= 400 && dup.s !== 429, dup.s);
  const ip = "10.88.250.250";
  const sts = [];
  for (let h = 0; h < 11; h++) sts.push((await call("POST", `/api/public/booking/${A.slug}/bookings`, { resourceId: res.id, customerName: "Spam", customerPhone: "+97455509999", date, hour: 3 }, null, ip)).s);
  check("COM-02 11th public booking from one device → 429", sts.slice(0, 10).every((s) => s !== 429) && sts[10] === 429, sts);
}

// ---- COM-05: روابط Link-in-Bio ----
{
  const bad = await call("POST", "/api/linktree/links", { label: "x", url: "javascript:alert(document.cookie)" }, A.t);
  const data = await call("POST", "/api/linktree/links", { label: "x", url: "data:text/html,<script>alert(1)</script>" }, A.t);
  const ok = await call("POST", "/api/linktree/links", { label: "Site", url: "https://example.com" }, A.t);
  const tel = await call("POST", "/api/linktree/links", { label: "Call", url: "tel:+97455501234" }, A.t);
  check("COM-05 javascript: and data: links are refused", bad.s === 400 && data.s === 400, { bad: bad.s, data: data.s });
  check("COM-05 https and tel links still work (authorized)", ok.s === 201 && tel.s === 201, { ok: ok.s, tel: tel.s });
  if (ok.s === 201) {
    const edit = await call("PATCH", `/api/linktree/links/${ok.d.id}`, { url: "javascript:alert(1)" }, A.t);
    check("COM-05 editing a link to javascript: is refused", edit.s === 400, edit.s);
  }
}

// ---- COM-06: تعديل نقاط الولاء يدوي ----
{
  const cust = await call("POST", "/api/wallet/customers", { name: "Lina Loyal", phone: "+97455507001" }, A.t);
  const off = await call("PATCH", "/api/wallet/settings", { allowOverrides: false }, A.t);
  const adj = await call("POST", `/api/wallet/customers/${cust.d.id}/adjust`, { delta: 5 }, A.t);
  check("COM-06 manual change refused when the owner turned it off", off.s === 200 && adj.s === 403, { off: off.s, adj: adj.s });
  await call("PATCH", "/api/wallet/settings", { allowOverrides: true }, A.t);
  const adj2 = await call("POST", `/api/wallet/customers/${cust.d.id}/adjust`, { delta: 5 }, A.t);
  const huge = await call("POST", `/api/wallet/customers/${cust.d.id}/adjust`, { delta: 1_000_000 }, A.t);
  check("COM-06 allowed when on (authorized), huge numbers refused", adj2.s === 200 && huge.s === 400, { adj2: adj2.s, huge: huge.s });
  // COM-08
  const look = await call("GET", `/api/public/wallet/${A.slug}/lookup?phone=55507001`);
  check("COM-08 public wallet phone lookup returns nothing", look.s === 410 && !JSON.stringify(look.d).includes("Lina"), look);
}

// ---- COM-07: طلبات المنيو العامة ----
{
  await call("POST", "/api/catalog/demo-menu", {}, A.t);
  const item = await db.menuItem.findFirst({ where: { tenantId: A.id } });
  const big = await call("POST", `/api/public/menu/${A.slug}/orders`, { mode: "PICKUP", customerName: "Ali", customerPhone: "+97455501010", items: [{ menuItemId: item.id, quantity: 100000 }] });
  check("COM-07 huge quantity is refused", big.s === 400, big);
  const ip = "10.88.251.1";
  const sts = [];
  for (let i = 0; i < 21; i++) sts.push((await call("POST", `/api/public/menu/${A.slug}/orders`, { mode: "PICKUP", customerName: "Ali", customerPhone: "+97455501010", items: [] }, null, ip)).s);
  check("COM-07 21st order from one device → 429", sts.slice(0, 20).every((s) => s !== 429) && sts[20] === 429, sts);
}

// ---- ERP-02 / ERP-06 ----
{
  const t0 = Date.now();
  const trend = await call("GET", "/api/bi/revenue-trend?days=99999999", null, A.t);
  check("ERP-02 huge days answers fast with at most 366 days", trend.s === 200 && Date.now() - t0 < 10_000 && (!Array.isArray(trend.d) || trend.d.length <= 366), { s: trend.s, ms: Date.now() - t0, n: trend.d?.length });
  const emp = await call("POST", "/api/employees", { branchId: A.branchId, name: "Sami Salary", position: "Barista", baseSalary: 1234 }, A.t);
  const staffEmail = `staffer-${tag}@example.test`;
  await call("POST", "/api/users", { name: "Stan Staff", email: staffEmail, password: "LocalPass123", role: "STAFF" }, A.t);
  const st = (await call("POST", "/api/auth/login", { email: staffEmail, password: "LocalPass123" })).d.accessToken;
  const staffList = await call("GET", "/api/employees", null, st);
  const ownerList = await call("GET", "/api/employees", null, A.t);
  const slip = await call("GET", `/api/employees/${emp.d.id}/payslip`, null, st);
  check("ERP-06 staff see names but not salaries", staffList.s === 200 && staffList.d.length > 0 && !JSON.stringify(staffList.d).includes("baseSalary"), staffList.d?.[0]);
  check("ERP-06 staff can't open payslips", slip.s === 403, slip.s);
  check("ERP-06 owner still sees salaries (authorized)", ownerList.s === 200 && JSON.stringify(ownerList.d).includes("baseSalary"), ownerList.s);
}

// ---- SEC-002 / AUTH-10: الجلسات ----
{
  const C = await company("Romeo Co", ["booking"]);
  const rows = await db.refreshToken.findMany({ where: { user: { email: C.email } } });
  check("SEC-002 refresh tokens are stored as fingerprints, not the token", rows.length > 0 && rows.every((r) => r.token !== C.refresh && /^[0-9a-f]{64}$/.test(r.token)), rows.map((r) => r.token.slice(0, 12)));
  const both = await Promise.all([1, 2, 3].map(() => call("POST", "/api/auth/refresh", { refreshToken: C.refresh })));
  check("SEC-002 one refresh token used 3 times at once → only one works", both.filter((r) => r.s === 200).length === 1 && both.filter((r) => r.s === 401).length === 2, both.map((r) => r.s));
  const dev1 = both.find((r) => r.s === 200).d.refreshToken;
  const dev2 = (await call("POST", "/api/auth/login", { email: C.email, password: "LocalPass123" })).d;
  const pw = await call("POST", "/api/account/password", { currentPassword: "LocalPass123", newPassword: "NewLocalPass456", keepRefreshToken: dev1 }, C.t);
  const r1 = await call("POST", "/api/auth/refresh", { refreshToken: dev1 });
  const r2 = await call("POST", "/api/auth/refresh", { refreshToken: dev2.refreshToken });
  check("AUTH-10 password change signs out other devices, keeps this one", pw.s === 200 && r1.s === 200 && r2.s === 401, { pw: pw.s, keep: r1.s, other: r2.s });
}

// ---- SEC-003 / SEC-004 ----
{
  const r = await raw("GET", "/health");
  check("SEC-003 security headers present", r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("x-frame-options") === "DENY" && !r.headers.get("x-powered-by"), Object.fromEntries(r.headers));
  for (const url of ["https://198.18.0.1/hook", "https://[64:ff9b::a9fe:a9fe]/hook", "https://[::ffff:127.0.0.1]/hook", "https://[fec0::1]/hook"]) {
    const w = await call("POST", "/api/integrations/webhooks", { url, events: ["booking.created"] }, A.t);
    check(`SEC-004 webhook to private address refused: ${url}`, w.s === 400 || w.s === 403, w);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.$disconnect();
process.exit(fail ? 1 : 0);
