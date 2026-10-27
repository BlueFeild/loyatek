import { prisma } from "../../config/db";
import { getOrCreateWhatsappSettings, getWhatsappTemplateStatus } from "./whatsapp.service";

// إرسال قالب معتمد من شاشة المحادثات: لما الـ24 ساعة تعدّي (واتساب مايسمحش بنص حر)
// أو لما التاجر يفتح محادثة جديدة مع أي رقم. Meta بتسمح بالقوالب المعتمدة لأي رقم في
// أي وقت، والعميل لو رد بتتفتح نافذة 24 ساعة جديدة للنص الحر

// hello_world: قالب Meta التجريبي (موجود عند كل الحسابات، إنجليزي، من غير متغيرات)
export const HELLO_WORLD_ID = "hello_world";
export const HELLO_WORLD_TEXT = "Hello World\nWelcome and congratulations!! This message demonstrates your ability to send a WhatsApp message notification from the Cloud API, hosted by Meta.";

// عدد المتغيرات = أكبر رقم {{n}} في نص القالب
export function templateParamCount(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

// النص اللي اتبعت فعلًا (عشان يظهر في المحادثة زي ما العميل شافه)
export function renderTemplateText(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v && v.trim() ? v.trim() : "-";
  });
}

export interface SendableTemplate {
  id: string;
  name: string;
  language: string;
  bodyText: string;
  paramCount: number;
  status: string;
  // ممكن يتبعت من هنا؟ (معتمد ومن غير صورة رأس) - غير كده السبب
  sendable: boolean;
  reason: string | null;
}

// القوالب: المعتمدة الأول. اللي لسه PENDING بنسأل Meta عن حالتها (أول 10 بس)
// الأعمدة اللي القايمة محتاجاها بس (من غير صور الرأس/الكروت التقيلة)
const LIST_FIELDS = { id: true, name: true, language: true, bodyText: true, status: true, metaTemplateId: true } as const;

export async function listInboxTemplates(tenantId: string): Promise<SendableTemplate[]> {
  const rows = await prisma.whatsappTemplate.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, select: LIST_FIELDS });
  const pending = rows.filter((t) => t.status === "PENDING" && t.metaTemplateId).slice(0, 10);
  if (pending.length) {
    const s = await getOrCreateWhatsappSettings(tenantId);
    const token = s.metaAccessToken;
    if (token) {
      // كل الأسئلة لـ Meta مع بعض، والنتيجة بتتحدث في نفس الصفوف (من غير استعلام تاني)
      await Promise.all(
        pending.map(async (t) => {
          const check = await getWhatsappTemplateStatus(token, t.metaTemplateId!);
          if (check.ok && (check.status === "APPROVED" || check.status === "REJECTED")) {
            await prisma.whatsappTemplate.update({ where: { id: t.id }, data: { status: check.status, rejectionReason: check.rejectionReason ?? null } });
            t.status = check.status;
          }
        })
      );
    }
  }
  const list: SendableTemplate[] = rows.map((t) => {
    const reason =
      t.status !== "APPROVED"
        ? t.status === "REJECTED"
          ? "Rejected by Meta"
          : "Waiting for Meta approval"
        : null;
    return { id: t.id, name: t.name, language: t.language, bodyText: t.bodyText, paramCount: templateParamCount(t.bodyText), status: t.status, sendable: !reason, reason };
  });
  list.push({ id: HELLO_WORLD_ID, name: "hello_world", language: "en_US", bodyText: HELLO_WORLD_TEXT, paramCount: 0, status: "APPROVED", sendable: true, reason: null });
  return list.sort((a, b) => Number(b.sendable) - Number(a.sendable));
}
