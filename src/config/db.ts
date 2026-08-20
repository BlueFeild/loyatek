import { PrismaClient } from "@prisma/client";

// نسخة واحدة من الاتصال بقاعدة البيانات تُستخدم في كل المشروع
export const prisma = new PrismaClient();
