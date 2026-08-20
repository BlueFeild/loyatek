import { prisma } from "../../config/db";

export async function getOrCreateCatalogSettings(tenantId: string) {
  const existing = await prisma.catalogSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;
  return prisma.catalogSettings.create({ data: { tenantId } });
}

interface UpdateCatalogSettingsInput {
  brandName?: string;
  brandLogoDataUrl?: string | null;
  menuLayout?: string;
  dineInEnabled?: boolean;
  pickupEnabled?: boolean;
  tableCount?: number;
  merchantEmail?: string;
  kitchenWhatsapp?: string;
  prepTime?: number;
  themeColor?: string;
}

export async function updateCatalogSettings(tenantId: string, data: UpdateCatalogSettingsInput) {
  await getOrCreateCatalogSettings(tenantId);
  return prisma.catalogSettings.update({ where: { tenantId }, data });
}

interface OrderItemInput {
  menuItemId: string;
  quantity: number;
}

interface CreateOrderInput {
  tenantId: string;
  branchId: string;
  mode: "DINE_IN" | "PICKUP";
  tableNumber?: number;
  readyTime?: number;
  customerName: string;
  customerPhone: string;
  items: OrderItemInput[];
}

// إنشاء طلب حقيقي - بياخد أسعار الأصناف الحقيقية من قاعدة البيانات وقت
// الطلب (مش من الفرونت إند)، عشان محدش يقدر يغيّر السعر من عنده
export async function createOrder(input: CreateOrderInput) {
  const menuItems = await prisma.menuItem.findMany({
    where: { tenantId: input.tenantId, id: { in: input.items.map((i) => i.menuItemId) } },
  });

  if (menuItems.length !== input.items.length) {
    throw new Error("One or more menu items were not found");
  }

  const lines = input.items.map((line) => {
    const item = menuItems.find((m: (typeof menuItems)[number]) => m.id === line.menuItemId)!;
    return { menuItemId: item.id, name: item.name, price: item.price, quantity: line.quantity };
  });

  const totalAmount = lines.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0);

  return prisma.catalogOrder.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      mode: input.mode,
      tableNumber: input.tableNumber,
      readyTime: input.readyTime,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      totalAmount,
      items: { create: lines },
    },
    include: { items: true },
  });
}
