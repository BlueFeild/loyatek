// شحن المتجر (2026-11-26): الواجهة الواحدة لكل شركات الشحن (Aramex / FedEx / DHL / Fake للاختبار).
// الخدمة (shipping.service.ts) بتكلّم ShippingCarrier بس - ماتعرفش أي حاجة عن API شركة معيّنة.

export const CARRIERS = ["ARAMEX", "FEDEX", "DHL"] as const;
export type CarrierCode = (typeof CARRIERS)[number];
export type CarrierMode = "TEST" | "LIVE";

export interface ShipAddress {
  name: string;
  company?: string | null;
  phone: string;
  email?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode?: string | null;
  // ISO-2 (QA, AE, SA ...)
  country: string;
}

export interface Parcel {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface RateRequest {
  origin: ShipAddress;
  destination: ShipAddress;
  parcel: Parcel;
  // قيمة البضاعة (للجمارك في الشحن الدولي)
  declaredValue: { amount: number; currency: string };
  shipDate: Date;
}

export interface ShipmentRequest extends RateRequest {
  service: string;
  description: string;
  // رقم الطلب عندنا (بيظهر على البوليصة)
  reference: string;
  pieces: number;
}

export interface CarrierRate {
  service: string;
  serviceName: string;
  amount: number;
  currency: string;
  estimatedDays?: number | null;
}

export interface CreatedShipment {
  trackingNumber: string;
  service: string;
  // PDF نفسه (FedEx / DHL) أو رابط (Aramex)
  labelPdf?: Buffer | null;
  labelUrl?: string | null;
}

export type TrackingStatus = "PENDING" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION" | "UNKNOWN";

export interface TrackingEvent {
  at: string; // ISO
  code: string;
  description: string;
  location?: string | null;
}

export interface TrackingResult {
  status: TrackingStatus;
  events: TrackingEvent[];
}

export interface ShippingCarrier {
  readonly code: CarrierCode;
  quoteRates(req: RateRequest): Promise<CarrierRate[]>;
  createShipment(req: ShipmentRequest): Promise<CreatedShipment>;
  track(trackingNumber: string): Promise<TrackingResult>;
  validateCredentials(sample: RateRequest): Promise<void>;
}

// مفاتيح كل شركة (بتتخزن متشفّرة كـ JSON)
export interface AramexCredentials {
  username: string;
  password: string;
  accountNumber: string;
  accountPin: string;
  accountEntity: string;
  accountCountryCode: string;
}
export interface FedexCredentials {
  apiKey: string;
  secretKey: string;
  accountNumber: string;
}
export interface DhlCredentials {
  apiKey: string;
  apiSecret: string;
  accountNumber: string;
}
export type CarrierCredentials = AramexCredentials | FedexCredentials | DhlCredentials;

// خطأ من شركة الشحن: auth = المفاتيح غلط، bad_request = البيانات (العنوان/الوزن)، unavailable = الشركة واقعة / بطيئة
export class CarrierError extends Error {
  constructor(
    readonly kind: "auth" | "bad_request" | "unavailable",
    message: string,
    readonly carrier?: CarrierCode
  ) {
    super(message);
    this.name = "CarrierError";
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

// روابط التتبع العامة (للعميل)
export function publicTrackingUrl(carrier: string, trackingNumber: string): string | null {
  const n = encodeURIComponent(trackingNumber);
  if (carrier === "ARAMEX") return `https://www.aramex.com/track/results?ShipmentNumber=${n}`;
  if (carrier === "FEDEX") return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (carrier === "DHL") return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`;
  return null;
}

export const CARRIER_NAMES: Record<CarrierCode, string> = { ARAMEX: "Aramex", FEDEX: "FedEx", DHL: "DHL Express" };
