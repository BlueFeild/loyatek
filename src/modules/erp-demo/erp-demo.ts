import { prisma } from "../../config/db";
import { getTenantMoney, toUsd } from "../../utils/money";
import { recordSale } from "../hr/sales.service";
import { createInvoice, issueInvoice } from "../accounting/invoices.service";
import { addInvoicePayment } from "../accounting/invoice-payments";
import { createJournalEntry } from "../accounting/journal.service";
import { postBillEntry, postPaymentEntry } from "../accounting/vendor-bills.routes";
import { DEFAULT_ACCOUNTS } from "../accounting/accounts.routes";
import { createPurchaseOrder, receivePurchaseOrder } from "../procurement/purchase-orders.service";

// بيانات تجريبية للـ ERP (عشان التاجر/السيلز يشرح الخدمات لعميل على شاشات مليانة):
// كافيه في الدوحة بفرعين، مخزون، موردين وأوامر شراء، موظفين بمرتبات، مبيعات 30 يوم،
// فواتير عملاء بدفعات، فواتير مصروفات، ميزانية، CRM، أصول، عربيات، تذاكر ومهام.
// كله بيتسجل بنفس دوال النظام الحقيقية (قيود متوازنة، مخزون بينقص، عمولات...).
// بيشتغل بس لو الـ ERP بتاع الشركة فاضي خالص - عشان مايختلطش بداتا عميل حقيقية

const DAY = 86400000;

export async function erpIsEmpty(tenantId: string): Promise<boolean> {
  const counts = await Promise.all([
    prisma.inventoryItem.count({ where: { tenantId } }),
    prisma.invoice.count({ where: { tenantId } }),
    prisma.employee.count({ where: { tenantId } }),
    prisma.journalEntry.count({ where: { tenantId } }),
    prisma.customer.count({ where: { tenantId } }),
    prisma.vendorBill.count({ where: { tenantId } }),
    prisma.sale.count({ where: { tenantId } }),
    prisma.supplier.count({ where: { tenantId } }),
  ]);
  return counts.every((c) => c === 0);
}

// مولّد أرقام ثابت (نفس الداتا كل مرة)
function rng(seed = 7) {
  let s = seed;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function seedErpDemo(tenantId: string, now: Date = new Date()) {
  const { rates } = await getTenantMoney(tenantId);
  // الأسعار مكتوبة بالريال القطري وبتتخزن بالدولار (زي باقي النظام) - بتظهر بعملة الشركة
  const Q = (qar: number) => Math.round(toUsd(qar, "QAR", rates) * 1e6) / 1e6;
  const rnd = rng();
  const ago = (days: number, hour = 10) => new Date(dayStart(now).getTime() - days * DAY + hour * 3600000);

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { branches: { orderBy: { createdAt: "asc" } } } });
  if (!tenant) throw new Error("Company not found");
  // الفواتير الضريبية محتاجة رقم ضريبي - بنحط رقم تجريبي بس لو مفيش
  if (!tenant.vatNumber) await prisma.tenant.update({ where: { id: tenantId }, data: { vatNumber: "300000000000003" } });
  let main = tenant.branches[0];
  if (!main) main = await prisma.branch.create({ data: { tenantId, name: "Main Branch", currency: tenant.displayCurrency } });
  const b1 = main.id;
  const b2 = (await prisma.branch.create({ data: { tenantId, name: "Lusail Marina", location: "Lusail", currency: tenant.displayCurrency } })).id;
  const b3 = (await prisma.branch.create({ data: { tenantId, name: "The Pearl Kiosk", location: "The Pearl-Qatar", currency: tenant.displayCurrency } })).id;

  // --- المخزون ---
  const items: Record<string, { id: string }> = {};
  const inv: [string, string, number, number, number, number, number | null, string][] = [
    ["Spanish Latte", "BEV-SPL", 4200, 200, 6, 22, null, b1],
    ["Flat White", "BEV-FW", 3600, 200, 5, 20, null, b1],
    ["Karak Tea", "BEV-KRK", 4000, 300, 2, 8, null, b1],
    ["Butter Croissant", "BAK-CRO", 2600, 150, 4, 14, 2, b1],
    ["Pistachio Kunafa", "DES-KUN", 2000, 100, 9, 32, 3, b1],
    ["Avocado Toast", "FOD-AVO", 1500, 80, 11, 38, 1, b1],
    ["Arabica Beans 1kg", "COF-ARB", 6, 10, 65, 95, null, b1],
    ["Oat Milk 1L", "DAI-OAT", 8, 20, 11, 16, 9, b1],
    ["Whole Milk 1L", "DAI-MLK", 140, 40, 6, 9, 6, b1],
    ["Takeaway Cups 12oz", "PKG-CUP", 1800, 300, 0.4, 1, null, b1],
    ["Spanish Latte (Lusail)", "BEV-SPL-2", 3000, 150, 6, 22, null, b2],
    ["Pistachio Kunafa (Lusail)", "DES-KUN-2", 1500, 80, 9, 32, null, b2],
    ["Karak Tea (Pearl)", "BEV-KRK-3", 2500, 150, 2, 8, null, b3],
  ];
  for (const [name, sku, quantity, reorderAt, cost, sell, exp, branchId] of inv) {
    items[sku] = await prisma.inventoryItem.create({
      data: { tenantId, branchId, name, sku, quantity, reorderAt, costPrice: Q(cost), sellPrice: Q(sell), expiryDate: exp ? new Date(now.getTime() + exp * DAY) : null },
    });
  }
  for (const [sku, qty, reason] of [["BAK-CRO", 14, "Expired"], ["DAI-MLK", 9, "Damaged"]] as const) {
    await prisma.$transaction([
      prisma.inventoryItem.update({ where: { id: items[sku].id }, data: { quantity: { decrement: qty } } }),
      prisma.inventoryMovement.create({ data: { itemId: items[sku].id, type: "WASTAGE", quantity: qty, reason } }),
    ]);
  }

  // --- الموردين + طلب عروض أسعار + أوامر شراء ---
  const sup: Record<string, { id: string }> = {};
  for (const [name, phone, leadTimeDays] of [
    ["Gulf Coffee Roasters", "+974 4411 2200", 5],
    ["Al Meera Dairy Supply", "+974 4455 8800", 2],
    ["Doha Fresh Bakery Co.", "+974 4433 1100", 1],
    ["Qatar Packaging Hub", "+974 4466 7700", 7],
  ] as const) {
    sup[name] = await prisma.supplier.create({ data: { tenantId, name, phone, leadTimeDays } });
  }
  await prisma.rfqRequest.create({
    data: {
      tenantId,
      branchId: b1,
      itemId: items["COF-ARB"].id,
      quotes: {
        create: [
          { supplierId: sup["Gulf Coffee Roasters"].id, price: Q(62), leadTimeDays: 5, rating: 5, selected: true },
          { supplierId: sup["Qatar Packaging Hub"].id, price: Q(71), leadTimeDays: 7, rating: 3 },
          { supplierId: sup["Al Meera Dairy Supply"].id, price: Q(68), leadTimeDays: 3, rating: 4 },
        ],
      },
    },
  });
  await createPurchaseOrder({ tenantId, branchId: b1, supplierId: sup["Gulf Coffee Roasters"].id, items: [{ itemId: items["COF-ARB"].id, quantity: 40, unitCost: Q(62) }] });
  const poDairy = await createPurchaseOrder({ tenantId, branchId: b1, supplierId: sup["Al Meera Dairy Supply"].id, items: [{ itemId: items["DAI-MLK"].id, quantity: 200, unitCost: Q(6) }, { itemId: items["DAI-OAT"].id, quantity: 60, unitCost: Q(11) }] });
  const poCups = await createPurchaseOrder({ tenantId, branchId: b1, supplierId: sup["Qatar Packaging Hub"].id, items: [{ itemId: items["PKG-CUP"].id, quantity: 3000, unitCost: Q(0.4) }] });
  await receivePurchaseOrder(tenantId, poDairy.id);
  await receivePurchaseOrder(tenantId, poCups.id);
  await prisma.purchaseOrder.update({ where: { id: poCups.id }, data: { createdAt: ago(40), dueDate: ago(4) } });
  await prisma.purchaseOrder.update({ where: { id: poDairy.id }, data: { createdAt: ago(6) } });
  // الحليب الشوفان يفضل قليل عشان يظهر "مخزون منخفض"
  await prisma.inventoryItem.update({ where: { id: items["DAI-OAT"].id }, data: { quantity: 8 } });

  // --- الموظفين (مرتب + تاريخ تعيين حقيقي) ---
  const emps: Record<string, { id: string }> = {};
  for (const [name, position, commissionRate, salary, target, years, branchId] of [
    ["Omar Haddad", "Store Manager", 0.03, 12000, 60000, 6.2, b1],
    ["Sara Mitchell", "Head Barista", 0.05, 7500, 38000, 3.4, b1],
    ["Rashid Khan", "Barista", 0.05, 5200, 30000, 1.6, b1],
    ["Lina Farouk", "Pastry Chef", 0.04, 6800, 25000, 4.8, b1],
    ["Mariam Saleh", "Cashier", 0.04, 4800, 28000, 2.1, b1],
    ["Yousef Nasser", "Branch Lead", 0.03, 9000, 45000, 5.1, b2],
    ["Hana Lee", "Barista", 0.05, 5000, 26000, 0.7, b3],
  ] as const) {
    emps[name] = await prisma.employee.create({
      data: { tenantId, branchId, name, position, commissionRate, baseSalary: Q(salary), monthlyTarget: Q(target), hireDate: new Date(now.getTime() - years * 365.25 * DAY) },
    });
  }

  // --- العملاء + أنشطة ---
  const custs: { id: string }[] = [];
  for (const [name, phone, email] of [
    ["Aisha Al-Thani", "+974 5550 1001", "aisha@example.qa"],
    ["Khalid Rahman", "+974 5550 1002", "khalid@example.qa"],
    ["Qatar Tech Hub", "+974 4400 1003", "events@qtechhub.example"],
    ["Fatima Noor", "+974 5550 1004", "fatima@example.qa"],
    ["Doha Events Co.", "+974 4400 1005", "hello@dohaevents.example"],
    ["Ahmed Saeed", "+974 5550 1006", "ahmed@example.qa"],
    ["Marina Towers Mgmt", "+974 4400 1007", "fm@marinatowers.example"],
    ["Noura Ali", "+974 5550 1008", "noura@example.qa"],
  ]) {
    custs.push(await prisma.customer.create({ data: { tenantId, name, phone, email } }));
  }
  for (const [type, text] of [
    ["CALL", "Discussed Q4 catering menu — 60 guests, vegan options"],
    ["EMAIL", "Sent proposal & tasting invitation"],
    ["NOTE", "Prefers oat milk; invoices go to finance@"],
  ] as const) {
    await prisma.activity.create({ data: { tenantId, customerId: custs[2].id, type, text } });
  }

  // --- مبيعات آخر 30 يوم (بتزيد مع الوقت) ---
  const b1Sellers = ["Sara Mitchell", "Rashid Khan", "Mariam Saleh", "Lina Farouk", "Omar Haddad"];
  const b1Items = ["BEV-SPL", "BEV-FW", "BEV-KRK", "BAK-CRO", "DES-KUN", "FOD-AVO"];
  let salesCount = 0;
  for (let d = 29; d >= 0; d--) {
    const n = 9 + Math.round((29 - d) / 5) + Math.round(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const [branchId, emp, sku] =
        r < 0.72
          ? [b1, b1Sellers[Math.floor(rnd() * b1Sellers.length)], b1Items[Math.floor(rnd() * b1Items.length)]]
          : r < 0.92
            ? [b2, "Yousef Nasser", rnd() < 0.6 ? "BEV-SPL-2" : "DES-KUN-2"]
            : [b3, "Hana Lee", "BEV-KRK-3"];
      const sale = await recordSale({
        tenantId,
        branchId,
        employeeId: emps[emp].id,
        itemId: items[sku].id,
        quantity: 4 + Math.floor(rnd() * 14),
        customerId: rnd() < 0.4 ? custs[Math.floor(rnd() * custs.length)].id : undefined,
      });
      const at = new Date(ago(d, 8).getTime() + Math.floor(rnd() * 12) * 3600000);
      const when = at > now ? now : at;
      await prisma.sale.update({ where: { id: sale.id }, data: { createdAt: when } });
      if (sale.journalEntryId) await prisma.journalEntry.update({ where: { id: sale.journalEntryId }, data: { date: when } });
      salesCount++;
    }
  }

  // --- الحسابات: دليل الحسابات + رأس المال + المرتبات ---
  for (const acc of [...DEFAULT_ACCOUNTS, { code: "1010", name: "Bank", type: "ASSET" as const }, { code: "1100", name: "Accounts Receivable", type: "ASSET" as const }, { code: "6200", name: "Salaries Expense", type: "EXPENSE" as const }]) {
    await prisma.account.upsert({ where: { tenantId_code: { tenantId, code: acc.code } }, update: {}, create: { tenantId, ...acc } });
  }
  const accId = async (code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code } })).id;
  await createJournalEntry({
    tenantId,
    description: "Owner capital injection",
    date: ago(60),
    lines: [
      { accountId: await accId("1000"), debit: Q(80000) },
      { accountId: await accId("1010"), debit: Q(170000) },
      { accountId: await accId("3000"), credit: Q(250000) },
    ],
  });
  await createJournalEntry({ tenantId, branchId: b1, description: "Payroll — last month", date: ago(Math.min(18, now.getUTCDate() + 1)), lines: [{ accountId: await accId("6200"), debit: Q(50300) }, { accountId: await accId("1010"), credit: Q(50300) }] });

  // --- فواتير عملاء: مدفوعة، جزء، متأخرة، ومسودة ---
  const invDefs: [number, [string, number, number][], number, "FULL" | "PART" | "NONE", number | null][] = [
    // [عميل، بنود (وصف، كمية، سعر بالريال)، من كام يوم، الدفع، ميعاد السداد بعد كام يوم]
    [2, [["Corporate breakfast catering — 60 guests", 1, 4800], ["Specialty coffee bar (half day)", 1, 2200]], 24, "FULL", 14],
    [4, [["Monthly office coffee subscription", 1, 3600]], 20, "FULL", 14],
    [6, [["Event dessert table", 1, 2750], ["Barista on-site (4h)", 2, 450]], 16, "PART", 14],
    [1, [["Pastry boxes (corporate gifts)", 40, 85]], 35, "NONE", 14],
    [0, [["Wedding coffee station", 1, 6200]], 3, "NONE", 30],
  ];
  const invoiceIds: string[] = [];
  for (const [ci, lines, daysAgo, pay, dueIn] of invDefs) {
    const invc = await createInvoice({ tenantId, branchId: b1, customerId: custs[ci].id, items: lines.map(([description, quantity, unit]) => ({ description, quantity, unitPrice: Q(unit) })), dueDate: dueIn ? ago(daysAgo - dueIn) : null, notes: "Thank you for choosing us!" });
    const issued = await issueInvoice(tenantId, invc.id);
    // تاريخ الإصدار وقيده يرجعوا لورا (عشان الشهور والتقارير تبان حقيقية)
    await prisma.invoice.update({ where: { id: invc.id }, data: { issuedAt: ago(daysAgo), createdAt: ago(daysAgo) } });
    if (issued.journalEntryId) await prisma.journalEntry.update({ where: { id: issued.journalEntryId }, data: { date: ago(daysAgo) } });
    if (pay === "FULL") await addInvoicePayment(tenantId, invc.id, { full: true, method: "BANK", paidAt: ago(Math.max(0, daysAgo - 7)), reference: "TRX-" + (1000 + invoiceIds.length) });
    if (pay === "PART") await addInvoicePayment(tenantId, invc.id, { amount: Q(2000), method: "CASH", paidAt: ago(daysAgo - 2) });
    invoiceIds.push(invc.id);
  }
  await createInvoice({ tenantId, branchId: b1, customerId: custs[3].id, items: [{ description: "Birthday cake + coffee for 20", quantity: 1, unitPrice: Q(1350) }] });

  // --- فواتير مصروفات (بقيودها) ---
  const bills: [string, string, number, number, boolean, number | null, string | null][] = [
    // [المورد، الفئة، المبلغ بالريال، من كام يوم، مدفوعة؟، ميعاد بعد كام يوم، الفرع]
    ["Doha Real Estate Co.", "Rent", 28000, 18, true, 5, b1],
    ["Lusail Mall Management", "Rent", 15000, 18, false, 10, b2],
    ["Kahramaa", "Utilities", 3400, 12, false, 7, b1],
    ["Ooredoo Business", "Subscriptions", 650, 9, true, 10, null],
    ["Doha Fresh Bakery Co.", "Supplies", 2900, 6, false, 14, b1],
    ["Instagram Ads", "Marketing", 1800, 4, true, 0, null],
  ];
  for (const [vendorName, category, qar, daysAgo, paid, dueIn, branchId] of bills) {
    const issueDate = ago(daysAgo);
    const amount = Q(qar);
    await prisma.$transaction(async (tx: any) => {
      const entry = await postBillEntry(tx, tenantId, { vendorName, amount, issueDate, branchId });
      const paidAt = paid ? issueDate : null;
      const payEntry = paidAt ? await postPaymentEntry(tx, tenantId, { vendorName, amount, paidAt, branchId }) : null;
      await tx.vendorBill.create({
        data: { tenantId, vendorName, category, amount, issueDate, dueDate: dueIn != null ? new Date(issueDate.getTime() + dueIn * DAY) : null, branchId, status: paid ? "PAID" : "UNPAID", paidAt, journalEntryId: entry.id, paymentJournalEntryId: payEntry?.id ?? null },
      });
    });
  }

  // --- الميزانية (الفعلي بيتحسب لوحده من المبيعات/الحسابات/الفواتير) ---
  const m = now.getUTCMonth() + 1, y = now.getUTCFullYear();
  for (const [category, budget] of [["Sales", 150000], ["Rent", 40000], ["Utilities", 3000], ["Marketing", 2500], ["Salaries Expense", 52000]] as const) {
    await prisma.budgetLine.create({ data: { tenantId, branchId: b1, category, periodMonth: m, periodYear: y, budgetedAmount: Q(budget) } });
  }

  // --- CRM: صفقات في مراحل مختلفة ---
  for (const [name, ci, value, stage] of [
    ["Qatar Tech Hub — Q4 office catering", 2, 48000, "WON"],
    ["Doha Events Co. — National Day booth", 4, 36500, "PROPOSAL"],
    ["Marina Towers — lobby coffee kiosk", 6, 92000, "QUALIFIED"],
    ["Corporate gifting — 300 boxes", 1, 25500, "LEAD"],
    ["Weekly breakfast — law firm", 5, 18400, "PROPOSAL"],
    ["University café partnership", 3, 120000, "LEAD"],
    ["Ramadan iftar catering", 7, 54000, "QUALIFIED"],
    ["Hotel pastry supply", 0, 31000, "LOST"],
  ] as const) {
    await prisma.deal.create({ data: { tenantId, customerId: custs[ci].id, name, value: Q(value), stage } });
  }

  // --- HR: ورديات الأسبوع + حضور الشهر ---
  const monday = dayStart(new Date(now.getTime() - ((now.getUTCDay() + 6) % 7) * DAY));
  const pattern = ["AM", "PM", "FULL", "AM", "OFF", "PM", "FULL"] as const;
  const empList = Object.values(emps);
  for (const [k, e] of empList.entries()) {
    await prisma.shift.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({ tenantId, employeeId: e.id, date: new Date(monday.getTime() + i * DAY), type: pattern[(i + k) % 7] })),
      skipDuplicates: true,
    });
    const att = [];
    for (let dd = 1; dd <= now.getUTCDate(); dd++) {
      if ((dd + k) % 7 === 0) continue;
      att.push({ tenantId, employeeId: e.id, date: new Date(Date.UTC(y, m - 1, dd)), status: (rnd() < 0.93 ? "ON_SHIFT" : "ABSENT") as "ON_SHIFT" | "ABSENT" });
    }
    await prisma.attendance.createMany({ data: att, skipDuplicates: true });
  }

  // --- أصول ثابتة + عربيات ---
  for (const [name, years, value, usefulLifeYears, category, branchId] of [
    ["La Marzocco espresso machine", 2.5, 68000, 7, "Equipment", b1],
    ["Kitchen fit-out — West Bay", 3.2, 240000, 10, "Fit-out", b1],
    ["POS terminals (x6)", 1.4, 21000, 4, "IT", b1],
    ["Delivery van", 2.1, 115000, 6, "Vehicles", b2],
  ] as const) {
    await prisma.fixedAsset.create({ data: { tenantId, branchId, name, category, purchaseDate: new Date(now.getTime() - years * 365 * DAY), purchaseValue: Q(value), usefulLifeYears, salvageValue: Q(value * 0.1) } });
  }
  const vans = [];
  for (const [plateNumber, make, model, year, mileage, status] of [
    ["123456", "Toyota", "Hiace", 2022, 48200, "ACTIVE"],
    ["204871", "Nissan", "Urvan", 2021, 63900, "IN_SERVICE"],
    ["311902", "Ford", "Transit", 2023, 21500, "ACTIVE"],
  ] as const) {
    vans.push(await prisma.vehicle.create({ data: { tenantId, branchId: b1, plateNumber, make, model, year, mileage, status, nextServiceDate: new Date(now.getTime() + 20 * DAY) } }));
  }
  await prisma.vehicleServiceLog.create({ data: { vehicleId: vans[0].id, serviceDate: ago(12), description: "Oil & filter change", cost: Q(450), mileageAt: 47800 } });

  // --- تذاكر دعم + مهام تشغيل ---
  for (const [subject, ci, status, priority] of [
    ["Wrong order delivered — catering", 2, "IN_PROGRESS", "HIGH"],
    ["Invoice copy requested", 4, "RESOLVED", "LOW"],
    ["Allergy information for desserts", 0, "OPEN", "MEDIUM"],
    ["Late delivery complaint", 6, "OPEN", "URGENT"],
  ] as const) {
    await prisma.supportTicket.create({ data: { tenantId, customerId: custs[ci].id, subject, status, priority } });
  }
  for (const [title, emp, status, priority, dueIn] of [
    ["Deep-clean espresso machines", "Sara Mitchell", "TODO", "HIGH", 1],
    ["Count stock before month end", "Omar Haddad", "IN_PROGRESS", "MEDIUM", 3],
    ["Train new barista on latte art", "Sara Mitchell", "TODO", "LOW", 7],
    ["Fix fridge temperature alarm", "Rashid Khan", "DONE", "HIGH", -1],
  ] as const) {
    await prisma.opsTask.create({ data: { tenantId, branchId: b1, title, assigneeId: emps[emp].id, status, priority, dueDate: new Date(now.getTime() + dueIn * DAY) } });
  }

  return {
    branches: 3,
    inventoryItems: inv.length,
    suppliers: Object.keys(sup).length,
    employees: empList.length,
    customers: custs.length,
    sales: salesCount,
    invoices: invoiceIds.length + 1,
    vendorBills: bills.length,
  };
}
