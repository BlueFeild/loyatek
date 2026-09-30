import { prisma } from "../config/db";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "store";
}

// بيولّد رابط فريد من اسم الشركة، ولو محجوز بيضيف رقم عشوائي في الآخر
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let attempt = 0;

  while (await prisma.tenant.findUnique({ where: { slug: candidate } })) {
    attempt += 1;
    candidate = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    if (attempt > 10) {
      candidate = `${base}-${Date.now()}`;
      break;
    }
  }
  return candidate;
}
