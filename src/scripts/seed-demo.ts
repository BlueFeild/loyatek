// سكريبت زرع بيانات تجريبية واقعية لكل موديولات النظام - عشان العميل
// يجرب النظام مليان ببيانات حقيقية بدل شاشات فاضية. الاستخدام:
// npm run seed-demo
//
// بيستخدم نفس دوال الـ service الحقيقية (recordSale, createInvoice,
// createBooking, createOrder...) مش إدخال صفوف عشوائية في قاعدة
// البيانات - عشان البيانات تكون متسقة فعليًا (مخزون بينقص صح، عمولات
// بتتحسب صح، قيود محاسبية متوازنة، إلخ)
import bcrypt from "bcryptjs";
import { prisma } from "../config/db";
import { generateUniqueSlug } from "../utils/slug";
import { recordSale } from "../modules/hr/sales.service";
import { createInvoice, issueInvoice } from "../modules/accounting/invoices.service";
import { createBooking } from "../modules/booking/bookings.service";
import { createOrder as createCatalogOrder } from "../modules/catalog/catalog.service";
import { getOrCreateWalletSettings } from "../modules/wallet/wallet.service";
import { getOrCreateCatalogSettings } from "../modules/catalog/catalog.service";
import { getOrCreateSettings as getOrCreateBookingSettings } from "../modules/booking/bookings.service";

const DEMO_EMAIL = "demo@bluefield.com";
const DEMO_PASSWORD = "DemoPass123";

async function main() {
  console.log("🌱 Seeding demo data…\n");

  // --- 1. الشركة والمستخدم ---------------------------------------
  let user = await prisma.user.findFirst({ where: { email: DEMO_EMAIL } });
  let tenant;

  if (user) {
    tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
    // لو الشركة اتعملت قبل كده باسم قديم، نحدّثها للاسم الجديد بدل ما
    // نسيبها زي ما هي - عشان الحساب التجريبي يفضل متزامن مع أحدث سكريبت
    if (tenant && tenant.name !== "BlueField") {
      tenant = await prisma.tenant.update({ where: { id: tenant.id }, data: { name: "BlueField" } });
    }
    console.log(`↺ Using existing demo tenant "${tenant!.name}"`);
  } else {
    const slug = await generateUniqueSlug("BlueField");
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    tenant = await prisma.tenant.create({
      data: {
        name: "BlueField",
        industry: "RETAIL",
        slug,
        vatNumber: "300000000000003",
        // اشتراك حقيقي دائم في كل الخدمات - عشان العميل يجرب حتى
        // الروابط والـ QR كودات العامة بدون قيود التجربة المؤقتة
        subscribedModules: ["erp", "booking", "wallet", "whatsapp", "catalog"],
        users: { create: { name: "Demo Owner", email: DEMO_EMAIL, passwordHash, role: "OWNER" } },
      },
      include: { users: true },
    });
    user = tenant.users[0];
    console.log(`✔ Created tenant "${tenant.name}" (${tenant.slug})`);
  }

  const tenantId = tenant!.id;

  let branch = await prisma.branch.findFirst({ where: { tenantId } });
  if (!branch) {
    branch = await prisma.branch.create({ data: { tenantId, name: "Main Branch", location: "Doha, Qatar", currency: "USD" } });
    console.log("✔ Created Main Branch");
  }
  const branchId = branch.id;

  if (!user!.branchId) {
    await prisma.user.update({ where: { id: user!.id }, data: { branchId } });
  }

  // --- 2. المخزون ---------------------------------------------------
  const inventorySeed = [
    { name: "Espresso Beans 1kg", sku: "INV-001", quantity: 40, reorderAt: 10, costPrice: 12, sellPrice: 24 },
    { name: "Oat Milk Carton", sku: "INV-002", quantity: 8, reorderAt: 12, costPrice: 3, sellPrice: 6 }, // نقص متعمّد
    { name: "Paper Cups (100pk)", sku: "INV-003", quantity: 25, reorderAt: 5, costPrice: 8, sellPrice: 15 },
    { name: "Croissant (frozen)", sku: "INV-004", quantity: 30, reorderAt: 10, costPrice: 1.5, sellPrice: 4, expiryDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) }, // هينتهي قريب
    { name: "Chocolate Syrup", sku: "INV-005", quantity: 15, reorderAt: 5, costPrice: 6, sellPrice: 12 },
  ];
  const items: any[] = [];
  for (const seed of inventorySeed) {
    let item = await prisma.inventoryItem.findFirst({ where: { tenantId, sku: seed.sku } });
    if (!item) {
      item = await prisma.inventoryItem.create({ data: { tenantId, branchId, ...seed } });
      console.log(`✔ Inventory item "${item.name}"`);
    }
    items.push(item);
  }

  // حركة تلف حقيقية على صنف واحد - عشان تقرير Wastage & Expiry يبان
  const existingWastage = await prisma.inventoryMovement.findFirst({ where: { itemId: items[3].id, type: "WASTAGE" } });
  if (!existingWastage) {
    await prisma.inventoryMovement.create({ data: { itemId: items[3].id, type: "WASTAGE", quantity: 3, reason: "Damaged in freezer" } });
    await prisma.inventoryItem.update({ where: { id: items[3].id }, data: { quantity: { decrement: 3 } } });
    console.log("✔ Logged sample wastage");
  }

  // --- 3. الموردين والمشتريات ---------------------------------------
  let supplier = await prisma.supplier.findFirst({ where: { tenantId, name: "Gulf Coffee Traders" } });
  if (!supplier) {
    supplier = await prisma.supplier.create({ data: { tenantId, name: "Gulf Coffee Traders", email: "sales@gulfcoffee.example", phone: "+974 4444 1234" } });
    console.log("✔ Supplier added");
  }

  // --- 4. الموظفين والمبيعات (بتشغّل حساب العمولة الحقيقي) ---------
  let employee = await prisma.employee.findFirst({ where: { tenantId, name: "Sara Al-Kaabi" } });
  if (!employee) {
    employee = await prisma.employee.create({
      data: { tenantId, branchId, name: "Sara Al-Kaabi", position: "Store Manager", commissionRate: 0.08, baseSalary: 2500, monthlyTarget: 5000 },
    });
    console.log("✔ Employee added");

    // 3 عمليات بيع حقيقية - كل واحدة بتنقص المخزون فعليًا وتحسب عمولة
    await recordSale({ tenantId, branchId, employeeId: employee.id, itemId: items[0].id, quantity: 3 });
    await recordSale({ tenantId, branchId, employeeId: employee.id, itemId: items[2].id, quantity: 5 });
    await recordSale({ tenantId, branchId, employeeId: employee.id, itemId: items[4].id, quantity: 2 });
    console.log("✔ Recorded 3 real sales with computed commission");

    await prisma.shift.create({ data: { tenantId, employeeId: employee.id, date: new Date(), type: "AM" } }).catch(() => {});
    await prisma.attendance.create({ data: { tenantId, employeeId: employee.id, date: new Date(), status: "ON_SHIFT" } }).catch(() => {});
  }

  // --- 5. العملاء وCRM Pipeline ---------------------------------
  const customerNames = [
    { name: "Ahmed Al-Sayed", phone: "+974 5555 0101" },
    { name: "Fatima Hassan", phone: "+974 5555 0102" },
    { name: "Mohammed Rashid", phone: "+974 5555 0103" },
  ];
  const customers: any[] = [];
  for (const c of customerNames) {
    let customer = await prisma.customer.findFirst({ where: { tenantId, phone: c.phone } });
    if (!customer) {
      customer = await prisma.customer.create({ data: { tenantId, ...c } });
      console.log(`✔ Customer "${customer.name}"`);
    }
    customers.push(customer);
  }

  const dealSeed = [
    { customerIdx: 0, name: "Corporate Catering Contract", value: 3200, stage: "PROPOSAL" as const },
    { customerIdx: 1, name: "Monthly Coffee Subscription", value: 450, stage: "WON" as const },
    { customerIdx: 2, name: "Office Supply Deal", value: 900, stage: "LEAD" as const },
  ];
  for (const d of dealSeed) {
    const exists = await prisma.deal.findFirst({ where: { tenantId, name: d.name } });
    if (!exists) {
      await prisma.deal.create({ data: { tenantId, customerId: customers[d.customerIdx].id, name: d.name, value: d.value, stage: d.stage } });
      await prisma.activity.create({ data: { tenantId, customerId: customers[d.customerIdx].id, type: "NOTE", text: `Deal "${d.name}" created` } }).catch(() => {});
      console.log(`✔ Deal "${d.name}" (${d.stage})`);
    }
  }

  // --- 6. المحاسبة: فاتورة حقيقية بقيد وQR ------------------------
  const existingInvoice = await prisma.invoice.findFirst({ where: { tenantId } });
  if (!existingInvoice) {
    const invoice = await createInvoice({
      tenantId,
      branchId,
      customerId: customers[0].id,
      items: [{ description: "Espresso Beans 1kg x3", quantity: 3, unitPrice: 24 }],
    });
    await issueInvoice(tenantId, invoice.id);
    console.log("✔ Created & issued a real invoice with journal entry + QR");
  }

  // --- 7. الحجوزات -------------------------------------------------
  await getOrCreateBookingSettings(tenantId);
  let resource = await prisma.resource.findFirst({ where: { tenantId, name: "Sara Al-Kaabi (Barista)" } });
  if (!resource) {
    resource = await prisma.resource.create({ data: { tenantId, branchId, name: "Sara Al-Kaabi (Barista)", type: "STAFF" } });
    console.log("✔ Booking resource added");
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const existingBooking = await prisma.booking.findFirst({ where: { tenantId, resourceId: resource.id } });
  if (!existingBooking) {
    try {
      await createBooking({
        tenantId,
        branchId,
        resourceId: resource.id,
        customerName: "Layla Nasser",
        customerPhone: "+974 5555 0199",
        date: tomorrow,
        hour: 11,
      });
      console.log("✔ Sample booking created");
    } catch {
      /* لو السلوت محجوز بالفعل من محاولة سابقة، تجاهلي */
    }
  }

  // --- 8. بطاقة الولاء ----------------------------------------------
  await getOrCreateWalletSettings(tenantId);
  const walletCustomerSeed = [
    { name: "Ahmed Al-Sayed", phone: "+974 5555 0101", balance: 240 },
    { name: "Noor Ibrahim", phone: "+974 5555 0201", balance: 85 },
  ];
  for (const w of walletCustomerSeed) {
    const exists = await prisma.walletCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone: w.phone } } }).catch(() => null);
    if (!exists) {
      await prisma.walletCustomer.create({ data: { tenantId, name: w.name, phone: w.phone, balance: w.balance, tier: w.balance > 200 ? "GOLD_VIP" : "SILVER" } });
      console.log(`✔ Wallet customer "${w.name}"`);
    }
  }

  // --- 9. الكتالوج والطلبات -----------------------------------------
  await getOrCreateCatalogSettings(tenantId);
  let category = await prisma.menuCategory.findFirst({ where: { tenantId, name: "Hot Drinks" } });
  if (!category) {
    category = await prisma.menuCategory.create({ data: { tenantId, name: "Hot Drinks", sortOrder: 0 } });
    const latte = await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Café Latte", description: "Rich espresso with steamed milk", price: 4.5, sortOrder: 0 } });
    await prisma.menuItem.create({ data: { tenantId, categoryId: category.id, name: "Cappuccino", description: "Classic Italian favorite", price: 4.5, sortOrder: 1 } });
    console.log("✔ Catalog menu created");

    await createCatalogOrder({
      tenantId,
      branchId,
      mode: "DINE_IN",
      tableLabel: "B4",
      customerName: "Walk-in Guest",
      customerPhone: "+974 5555 0299",
      items: [{ menuItemId: latte.id, quantity: 2 }],
    });
    console.log("✔ Sample catalog order created");
  }

  // --- 10. واتساب (تخزين فعلي، بدون إرسال حقيقي) -------------------
  const existingFlow = await prisma.botFlowNode.findFirst({ where: { tenantId } });
  if (!existingFlow) {
    await prisma.botFlowNode.create({
      data: { tenantId, type: "trigger", badge: "TRIGGER", title: "Customer messages 'Hi'", desc: "Starts the welcome flow", sortOrder: 0 },
    });
    await prisma.botFlowNode.create({
      data: { tenantId, type: "message", badge: "MESSAGE", title: "Send welcome message", desc: "Greets the customer and shows the menu", sortOrder: 1 },
    });
    await prisma.whatsappCampaign.create({
      data: { tenantId, name: "Weekend Promo", segmentDesc: "All loyalty members", templateText: "Enjoy 15% off this weekend!", status: "DRAFT" },
    });
    console.log("✔ WhatsApp flow & campaign draft added");
  }

  // --- 11. العمليات (Ops Tasks) --------------------------------------
  const taskExists = await prisma.opsTask.findFirst({ where: { tenantId } });
  if (!taskExists) {
    await prisma.opsTask.create({ data: { tenantId, branchId, title: "Restock oat milk", priority: "HIGH", assigneeId: employee.id, status: "TODO" } });
    await prisma.opsTask.create({ data: { tenantId, branchId, title: "Deep clean espresso machine", priority: "MEDIUM", status: "IN_PROGRESS" } });
    console.log("✔ Ops tasks added");
  }

  // --- 12. الأصول الثابتة ---------------------------------------------
  const assetExists = await prisma.fixedAsset.findFirst({ where: { tenantId } });
  if (!assetExists) {
    await prisma.fixedAsset.create({
      data: { tenantId, branchId, name: "La Marzocco Espresso Machine", category: "Equipment", purchaseDate: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000), purchaseValue: 12000, usefulLifeYears: 8, salvageValue: 1000 },
    });
    console.log("✔ Fixed asset added");
  }

  // --- 13. الميزانية -------------------------------------------------
  const now = new Date();
  const budgetExists = await prisma.budgetLine.findFirst({ where: { tenantId, periodMonth: now.getMonth() + 1, periodYear: now.getFullYear() } });
  if (!budgetExists) {
    await prisma.budgetLine.create({ data: { tenantId, branchId, category: "Ingredients", periodMonth: now.getMonth() + 1, periodYear: now.getFullYear(), budgetedAmount: 3000 } });
    await prisma.budgetLine.create({ data: { tenantId, branchId, category: "Marketing", periodMonth: now.getMonth() + 1, periodYear: now.getFullYear(), budgetedAmount: 800 } });
    console.log("✔ Budget lines added");
  }

  // --- 14. الأسطول ---------------------------------------------------
  const vehicleExists = await prisma.vehicle.findFirst({ where: { tenantId } });
  if (!vehicleExists) {
    const vehicle = await prisma.vehicle.create({ data: { tenantId, branchId, plateNumber: "QAT-4521", make: "Toyota", model: "Hiace", year: 2022, mileage: 18500 } });
    await prisma.vehicleServiceLog.create({ data: { vehicleId: vehicle.id, description: "Oil change & inspection", cost: 220, mileageAt: 18500 } });
    console.log("✔ Fleet vehicle added");
  }

  // --- 15. التصنيع (BOM) ----------------------------------------------
  const bomExists = await prisma.billOfMaterials.findFirst({ where: { tenantId } });
  if (!bomExists) {
    await prisma.billOfMaterials.create({
      data: {
        tenantId,
        productName: "Signature Latte Recipe",
        components: { create: [{ itemId: items[0].id, quantityUsed: 1 }] },
      },
    });
    console.log("✔ Bill of Materials added");
  }

  // --- 16. تذاكر الدعم -------------------------------------------------
  const ticketExists = await prisma.supportTicket.findFirst({ where: { tenantId } });
  if (!ticketExists) {
    const ticket = await prisma.supportTicket.create({ data: { tenantId, customerId: customers[1].id, subject: "Wrong order delivered", priority: "MEDIUM", status: "OPEN" } });
    await prisma.supportTicketReply.create({ data: { ticketId: ticket.id, authorName: "Support Agent", message: "We're sorry for the mix-up — a replacement is on its way!" } });
    console.log("✔ Support ticket added");
  }

  // --- 17. الأتمتة -----------------------------------------------------
  const ruleExists = await prisma.automationRule.findFirst({ where: { tenantId } });
  if (!ruleExists) {
    await prisma.automationRule.create({ data: { tenantId, name: "Alert on low stock", triggerType: "low_stock", actionType: "notify_whatsapp", enabled: true } });
    console.log("✔ Automation rule added");
  }

  console.log("\n🎉 Demo data seeded successfully!");
  console.log("─────────────────────────────────────");
  console.log(`  Login:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Public menu:    /menu/${tenant!.slug}`);
  console.log(`  Public booking: /book/${tenant!.slug}`);
  console.log(`  Loyalty join:   /join/${tenant!.slug}`);
  console.log("─────────────────────────────────────");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
