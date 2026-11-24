import { prisma } from "../../config/db";

// رقم واتساب (phone_number_id من Meta) متوصّل بشركة تانية على المنصة؟ (تدقيق MSG-06)
// الرسايل الجاية بتتوجّه لشركة واحدة بس حسب الرقم، فلو شركتين وصّلوا نفس الرقم كانت الرسايل بتروح
// لآخر واحدة اتأكدت - يعني شركة تانية ممكن "تسحب" رسايل عملاء شركة. دلوقتي الرقم لشركة واحدة بس
export const NUMBER_TAKEN_MESSAGE =
  "This WhatsApp number is already connected to another BlueField company. Disconnect it there first, or contact BlueField.";

export async function phoneNumberTakenElsewhere(tenantId: string, phoneNumberId: string, db: any = prisma): Promise<boolean> {
  const [main, extra] = await Promise.all([
    db.whatsappSettings.count({ where: { metaPhoneNumberId: phoneNumberId, isConnected: true, tenantId: { not: tenantId } } }),
    db.whatsappNumber.count({ where: { phoneNumberId, isConnected: true, tenantId: { not: tenantId } } }),
  ]);
  return main + extra > 0;
}
