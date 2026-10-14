import { getRates, toUsd } from "../../utils/money";
import { prisma } from "../../config/db";

// منيو تجريبي جاهز - التاجر يضغط زرار ويشوف التصميمات الأربعة (List / Grid /
// Gallery / Story) مليانة بأصناف وصور، ويجرّب يطلب. الصور SVG صغيرة
// متولّدة هنا (لون + إيموجي) - مفيش تحميل صور من برّه. الأقسام بتتعلّم
// isDemo عشان يقدر يشيلها بزرار واحد من غير ما يلمس أصنافه الحقيقية

function svgPhoto(emoji: string, from: string, to: string) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="400" height="300" fill="url(#g)"/>` +
    `<circle cx="320" cy="60" r="90" fill="#ffffff" opacity="0.08"/>` +
    `<text x="200" y="185" font-size="130" text-anchor="middle">${emoji}</text></svg>`;
  // encodeURIComponent مابيعملش encode للأقواس ( ) و' - ودول بيكسروا
  // CSS url(...) من غير علامات تنصيص (الصورة كانت مابتظهرش)
  const encoded = encodeURIComponent(svg).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/'/g, "%27");
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

const DEMO_MENU = [
  {
    name: "Hot Drinks",
    items: [
      { name: "Spanish Latte", description: "Double espresso, condensed milk, silky foam", price: 18, emoji: "☕", c: ["#7c4a2d", "#d6a77a"] },
      { name: "Karak Tea", description: "Slow-brewed black tea with cardamom & saffron", price: 8, emoji: "🫖", c: ["#9a3412", "#fdba74"] },
      { name: "Hot Chocolate", description: "Belgian chocolate, whipped cream", price: 16, emoji: "🍫", c: ["#3f2a1d", "#a16207"] },
      { name: "Flat White", description: "Velvety micro-foam over a ristretto shot", price: 17, emoji: "☕", c: ["#57534e", "#d6d3d1"] },
    ],
  },
  {
    name: "Breakfast",
    items: [
      { name: "Avocado Toast", description: "Sourdough, smashed avocado, poached egg", price: 32, emoji: "🥑", c: ["#3f6212", "#bef264"] },
      { name: "Butter Croissant", description: "Freshly baked every morning", price: 12, emoji: "🥐", c: ["#b45309", "#fde68a"] },
      { name: "Shakshuka", description: "Eggs in spiced tomato sauce, warm bread", price: 28, emoji: "🍳", c: ["#b91c1c", "#fca5a5"] },
    ],
  },
  {
    name: "Desserts",
    items: [
      { name: "Pistachio Kunafa", description: "Crispy kunafa, cream, crushed pistachio", price: 26, emoji: "🍰", c: ["#be185d", "#f9a8d4"] },
      { name: "Chocolate Brownie", description: "Warm brownie with vanilla ice cream", price: 22, emoji: "🧁", c: ["#4c1d95", "#c4b5fd"] },
      { name: "Fresh Fruit Cup", description: "Seasonal fruits, honey & mint", price: 18, emoji: "🍓", c: ["#9f1239", "#fda4af"] },
    ],
  },
];

export async function addDemoMenu(tenantId: string) {
  // بنضيف بس الأقسام التجريبية الناقصة (مثلاً بعد ما اتشال جزء منها وفضل
  // قسم عليه أوردر) - من غير تكرار
  const existing = await prisma.menuCategory.findMany({ where: { tenantId, isDemo: true }, select: { name: true } });
  const have = new Set(existing.map((c) => c.name));
  const missing = DEMO_MENU.filter((c) => !have.has(c.name));
  if (missing.length === 0) return { created: 0, alreadyThere: true };

  const offset = await prisma.menuCategory.count({ where: { tenantId } });
  // بسعر الصرف الحالي عشان المنيو القطري يعرض 18.00 بالظبط مش 17.95
  const rates = await getRates();
  let created = 0;
  for (let ci = 0; ci < missing.length; ci++) {
    const cat = missing[ci];
    await prisma.menuCategory.create({
      data: {
        tenantId,
        name: cat.name,
        isDemo: true,
        sortOrder: offset + ci,
        items: {
          create: cat.items.map((it, ii) => ({
            tenantId,
            name: it.name,
            description: it.description,
            // الأسعار التجريبية مكتوبة بالريال القطري، والتخزين بالدولار
            price: toUsd(it.price, "QAR", rates),
            photoDataUrl: svgPhoto(it.emoji, it.c[0], it.c[1]),
            sortOrder: ii,
          })),
        },
      },
    });
    created += cat.items.length;
  }
  return { created, alreadyThere: false };
}

// بيشيل الأقسام التجريبية بس. صنف عليه أوردر حقيقي مايتمسحش (سجل
// الأوردرات لازم يفضل سليم) - القسم ده بيفضل والتاجر يقدر يغيّر اسمه
export async function removeDemoMenu(tenantId: string) {
  const cats = await prisma.menuCategory.findMany({
    where: { tenantId, isDemo: true },
    include: { items: { include: { _count: { select: { orderItems: true } } } } },
  });
  let removed = 0;
  let kept = 0;
  for (const cat of cats) {
    const hasOrders = cat.items.some((i) => i._count.orderItems > 0);
    if (hasOrders) {
      kept++;
      continue;
    }
    await prisma.menuCategory.delete({ where: { id: cat.id } });
    removed++;
  }
  return { removed, kept };
}
