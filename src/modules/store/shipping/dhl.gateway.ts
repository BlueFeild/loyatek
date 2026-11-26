import { carrierRequest, digitsPhone, round2, trimBase } from "./carrier-http";
import {
  CarrierError,
  type CarrierMode,
  type CarrierRate,
  type CreatedShipment,
  type DhlCredentials,
  type FetchLike,
  type RateRequest,
  type ShipAddress,
  type ShipmentRequest,
  type ShippingCarrier,
  type TrackingEvent,
  type TrackingResult,
  type TrackingStatus,
} from "./shipping.types";

// DHL Express "MyDHL API" (REST) - المرجع: https://developer.dhl.com/api-reference/dhl-express-mydhl-api
//   test = https://express.api.dhl.com/mydhlapi/test ، live = https://express.api.dhl.com/mydhlapi (Basic auth: key + secret)
//   Rates:     GET  /rates?accountNumber&originCountryCode&originCityName&destinationCountryCode&destinationCityName&weight&length&width&height&plannedShippingDate&isCustomsDeclarable&unitOfMeasurement=metric
//   Shipment:  POST /shipments  (label PDF base64 في documents[])
//   Tracking:  GET  /shipments/{trackingNumber}/tracking
//   التجربة: 500 طلب في اليوم لكل مفتاح. DHL_BASE_URL بيغيّر العنوان للاختبار المحلي.
// ⚠️ مااتأكدش ضد DHL الحقيقي: templateName للبوليصة، شكل plannedShippingDateAndTime ("YYYY-MM-DDTHH:mm:ss GMT+00:00")،
//    و exportDeclaration للشحن الدولي المحتاج جمارك (DHL ممكن يطلب lineItems كاملة). كلها هنا بس.
export const DHL_LIVE_URL = "https://express.api.dhl.com/mydhlapi";
export const DHL_TEST_URL = "https://express.api.dhl.com/mydhlapi/test";

// DHL: OK = اتسلّم، WC = مع المندوب للتوصيل، PU = اتاخد، أي حاجة فيها problem/returned = مشكلة
export function dhlStatus(code: string, description: string): TrackingStatus {
  const c = (code || "").toUpperCase();
  const d = (description || "").toLowerCase();
  if (c === "OK" || /^delivered/.test(d)) return "DELIVERED";
  if (c === "WC" || /with delivery courier|out for delivery/.test(d)) return "OUT_FOR_DELIVERY";
  if (["NH", "CA", "RT", "MS", "BA", "OH", "RD"].includes(c) || /problem|returned|refused|incorrect|not home|on hold/.test(d)) return "EXCEPTION";
  if (c === "" || /shipment information received/.test(d)) return "PENDING";
  return "IN_TRANSIT";
}

const pad = (n: number) => String(n).padStart(2, "0");
export function dhlShipDateTime(d: Date): string {
  // ساعة بعد دلوقتي بالـ UTC (DHL بيرفض وقت فات)
  const t = new Date(Math.max(d.getTime(), Date.now() + 3600_000));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00 GMT+00:00`;
}

export class DhlCarrier implements ShippingCarrier {
  readonly code = "DHL" as const;
  private readonly base: string;
  constructor(
    private readonly creds: DhlCredentials,
    mode: CarrierMode,
    private readonly fetchImpl: FetchLike,
    baseOverride?: string | null
  ) {
    this.base = trimBase(baseOverride || (mode === "LIVE" ? DHL_LIVE_URL : DHL_TEST_URL));
  }

  private headers(json: boolean) {
    const h: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${this.creds.apiKey}:${this.creds.apiSecret}`).toString("base64")}`, Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private problem(j: any, status: number) {
    const extra = Array.isArray(j?.additionalDetails) ? j.additionalDetails.join(" · ") : "";
    return `DHL: ${[j?.detail || j?.title, extra].filter(Boolean).join(" — ") || `request failed (${status})`}`;
  }

  rateQuery(req: RateRequest): string {
    const intl = req.origin.country !== req.destination.country;
    const q = new URLSearchParams({
      accountNumber: this.creds.accountNumber,
      originCountryCode: req.origin.country,
      originCityName: req.origin.city,
      destinationCountryCode: req.destination.country,
      destinationCityName: req.destination.city,
      weight: String(round2(Math.max(0.1, req.parcel.weightKg))),
      length: String(Math.ceil(req.parcel.lengthCm)),
      width: String(Math.ceil(req.parcel.widthCm)),
      height: String(Math.ceil(req.parcel.heightCm)),
      plannedShippingDate: req.shipDate.toISOString().slice(0, 10),
      isCustomsDeclarable: String(intl),
      unitOfMeasurement: "metric",
    });
    if (req.origin.postalCode) q.set("originPostalCode", req.origin.postalCode);
    if (req.destination.postalCode) q.set("destinationPostalCode", req.destination.postalCode);
    return `/rates?${q.toString()}`;
  }

  async quoteRates(req: RateRequest): Promise<CarrierRate[]> {
    const r = await carrierRequest("DHL", this.fetchImpl, this.base + this.rateQuery(req), { method: "GET", headers: this.headers(false) });
    if (!r.ok) throw new CarrierError("bad_request", this.problem(r.json, r.status), "DHL");
    const products = Array.isArray(r.json?.products) ? r.json.products : [];
    const out: CarrierRate[] = [];
    for (const p of products) {
      const prices = Array.isArray(p?.totalPrice) ? p.totalPrice : [];
      // BILLC = بعملة حساب التاجر؛ وإلا أول سعر
      const price = prices.find((x: any) => x?.currencyType === "BILLC" && Number(x?.price) > 0) ?? prices.find((x: any) => Number(x?.price) > 0);
      const amount = Number(price?.price);
      const currency = String(price?.priceCurrency ?? "").toUpperCase();
      if (!p?.productCode || !Number.isFinite(amount) || amount <= 0 || !currency) continue;
      const eta = p?.deliveryCapabilities?.totalTransitDays;
      out.push({ service: String(p.productCode), serviceName: String(p.productName || `DHL ${p.productCode}`), amount, currency, estimatedDays: Number(eta) > 0 ? Number(eta) : null });
    }
    return out;
  }

  shipBody(req: ShipmentRequest) {
    const intl = req.origin.country !== req.destination.country;
    const party = (a: ShipAddress) => ({
      postalAddress: {
        postalCode: a.postalCode || undefined,
        cityName: a.city,
        countryCode: a.country,
        addressLine1: a.line1.slice(0, 45),
        addressLine2: a.line2 ? a.line2.slice(0, 45) : undefined,
        provinceCode: a.state || undefined,
      },
      contactInformation: { phone: digitsPhone(a.phone), companyName: (a.company || a.name).slice(0, 100), fullName: a.name.slice(0, 255), email: a.email || undefined },
    });
    return {
      plannedShippingDateAndTime: dhlShipDateTime(req.shipDate),
      pickup: { isRequested: false },
      productCode: req.service,
      accounts: [{ typeCode: "shipper", number: this.creds.accountNumber }],
      customerReferences: [{ value: req.reference.slice(0, 35), typeCode: "CU" }],
      outputImageProperties: { encodingFormat: "pdf", imageOptions: [{ typeCode: "label", templateName: "ECOM26_84_001" }] },
      customerDetails: { shipperDetails: party(req.origin), receiverDetails: party(req.destination) },
      content: {
        packages: [
          {
            weight: round2(Math.max(0.1, req.parcel.weightKg)),
            dimensions: { length: Math.ceil(req.parcel.lengthCm), width: Math.ceil(req.parcel.widthCm), height: Math.ceil(req.parcel.heightCm) },
          },
        ],
        isCustomsDeclarable: intl,
        ...(intl ? { declaredValue: round2(req.declaredValue.amount), declaredValueCurrency: req.declaredValue.currency } : {}),
        description: req.description.slice(0, 70) || "Goods",
        incoterm: "DAP",
        unitOfMeasurement: "metric",
      },
    };
  }

  async createShipment(req: ShipmentRequest): Promise<CreatedShipment> {
    const r = await carrierRequest("DHL", this.fetchImpl, `${this.base}/shipments`, { method: "POST", headers: this.headers(true), body: JSON.stringify(this.shipBody(req)) });
    if (!r.ok || !r.json?.shipmentTrackingNumber) throw new CarrierError("bad_request", this.problem(r.json, r.status), "DHL");
    const docs = Array.isArray(r.json.documents) ? r.json.documents : [];
    const label = docs.find((d: any) => d?.typeCode === "label") ?? docs[0];
    const pdf = typeof label?.content === "string" ? Buffer.from(label.content, "base64") : null;
    return { trackingNumber: String(r.json.shipmentTrackingNumber), service: req.service, labelPdf: pdf, labelUrl: null };
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const url = `${this.base}/shipments/${encodeURIComponent(trackingNumber)}/tracking?trackingView=all-checkpoints&levelOfDetail=all`;
    const r = await carrierRequest("DHL", this.fetchImpl, url, { method: "GET", headers: this.headers(false) });
    if (!r.ok) throw new CarrierError("bad_request", this.problem(r.json, r.status), "DHL");
    const s = Array.isArray(r.json?.shipments) ? r.json.shipments[0] : null;
    const raw = Array.isArray(s?.events) ? s.events : [];
    const events: TrackingEvent[] = raw
      .map((e: any) => ({
        at: isoOf(e?.date, e?.time, e?.GMTOffset),
        code: String(e?.typeCode ?? ""),
        description: String(e?.description ?? ""),
        location: Array.isArray(e?.serviceArea) && e.serviceArea[0]?.description ? String(e.serviceArea[0].description) : null,
      }))
      .sort((a: TrackingEvent, b: TrackingEvent) => b.at.localeCompare(a.at));
    const latest = events[0];
    return { status: latest ? dhlStatus(latest.code, latest.description) : "PENDING", events };
  }

  async validateCredentials(sample: RateRequest): Promise<void> {
    // المفاتيح غلط = 401 (CarrierError auth من carrierRequest). أي رد تاني = DHL قبل المفاتيح
    await carrierRequest("DHL", this.fetchImpl, this.base + this.rateQuery(sample), { method: "GET", headers: this.headers(false) });
  }
}

function isoOf(date: unknown, time: unknown, offset: unknown): string {
  const off = typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "Z";
  const d = new Date(`${String(date ?? "")}T${String(time ?? "00:00:00")}${off}`);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}
