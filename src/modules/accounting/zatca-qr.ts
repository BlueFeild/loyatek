// تنسيق TLV (Tag-Length-Value) المستخدم فعليًا في فواتير ضريبة القيمة
// المضافة السعودية (ZATCA Phase 1): كل حقل = [Tag: 1 byte][Length: 1 byte][Value: UTF-8 bytes]
// النتيجة النهائية بتتحول لـ Base64 وتتحط في QR كود قابل للمسح فعليًا.

interface ZatcaFields {
  sellerName: string;
  vatNumber: string;
  timestamp: string; // ISO 8601
  invoiceTotal: string; // شامل الضريبة
  vatAmount: string;
}

function encodeTlvField(tag: number, value: string): Buffer {
  const valueBuffer = Buffer.from(value, "utf-8");
  const header = Buffer.from([tag, valueBuffer.length]);
  return Buffer.concat([header, valueBuffer]);
}

export function generateZatcaQrPayload(fields: ZatcaFields): string {
  const tlvFields = [
    encodeTlvField(1, fields.sellerName),
    encodeTlvField(2, fields.vatNumber),
    encodeTlvField(3, fields.timestamp),
    encodeTlvField(4, fields.invoiceTotal),
    encodeTlvField(5, fields.vatAmount),
  ];
  return Buffer.concat(tlvFields).toString("base64");
}
