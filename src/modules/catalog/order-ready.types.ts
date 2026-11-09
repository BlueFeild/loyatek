// زرار "الطلب جاهز": العقود بين الخدمة والتخزين وإرسال الرسالة

// template = قالب معتمد (بيوصل لأي رقم) | text = نص عادي (بيوصل بس جوه نافذة الـ24 ساعة)
export type ReadyNotifyResult =
  | { state: "template" | "text" | "not_connected" }
  | { state: "failed"; error: string };

export interface ReadyOrder {
  id: string;
  tenantId: string;
  mode: string;
  tableLabel: string | null;
  customerName: string;
  customerPhone: string;
  status: string;
  paymentStatus: string;
  paymentMethodType: string | null;
  readyAt: Date | null;
}

export interface OrderReadyStore {
  find(tenantId: string, orderId: string): Promise<ReadyOrder | null>;
  // بيحجز الإرسال ذريًا: ضغطتين مع بعض مايبعتوش رسالتين. الإعادة مسموحة بس لو المحاولة اللي فاتت ماوصلتش لـ Meta
  claim(tenantId: string, orderId: string, readyAt: Date): Promise<boolean>;
  saveResult(tenantId: string, orderId: string, result: ReadyNotifyResult): Promise<void>;
  load(tenantId: string, orderId: string): Promise<unknown>;
}

export interface OrderReadyNotifier {
  send(order: ReadyOrder): Promise<ReadyNotifyResult>;
}
