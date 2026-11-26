import { carrierRequest, digitsPhone, round2, trimBase } from "./carrier-http";
import {
  CarrierError,
  type CarrierMode,
  type CarrierRate,
  type CreatedShipment,
  type FedexCredentials,
  type FetchLike,
  type RateRequest,
  type ShipAddress,
  type ShipmentRequest,
  type ShippingCarrier,
  type TrackingEvent,
  type TrackingResult,
  type TrackingStatus,
} from "./shipping.types";

// FedEx REST APIs - المرجع: https://developer.fedex.com/api/en-us/catalog.html
//   OAuth:  POST /oauth/token (client_credentials, form) → access_token (ساعة) - https://developer.fedex.com/api/en-us/catalog/authorization/docs.html
//   Rates:  POST /rate/v1/rates/quotes        - https://developer.fedex.com/api/en-us/catalog/rate/v1/docs.html
//   Ship:   POST /ship/v1/shipments            - https://developer.fedex.com/api/en-us/catalog/ship/v1/docs.html
//   Track:  POST /track/v1/trackingnumbers     - https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
// sandbox = https://apis-sandbox.fedex.com ، live = https://apis.fedex.com (FEDEX_BASE_URL بيغيّره للاختبار المحلي)
// ⚠️ مااتأكدش ضد FedEx الحقيقي: customsClearanceDetail للشحن الدولي (FedEx ممكن يطلب حقول زيادة حسب الدولة)،
//    labelStockType، وأكواد الحالة (DL/OD/DE). كلها هنا بس.
export const FEDEX_LIVE_URL = "https://apis.fedex.com";
export const FEDEX_TEST_URL = "https://apis-sandbox.fedex.com";

// FedEx: DL = اتسلّم، OD = طلع للتوصيل، DE/SE/CA = مشكلة، OC/PX = لسه متعمل بس
export function fedexStatus(code: string): TrackingStatus {
  const c = (code || "").toUpperCase();
  if (c === "DL") return "DELIVERED";
  if (c === "OD") return "OUT_FOR_DELIVERY";
  if (c === "DE" || c === "SE" || c === "CA" || c === "RS" || c === "DY") return "EXCEPTION";
  if (c === "OC" || c === "PX" || c === "") return "PENDING";
  return "IN_TRANSIT";
}

// توكن لكل حساب (ساعة) - بنخزّنه في الذاكرة ونجدده قبل ما يخلص بدقيقة
const tokens = new Map<string, { token: string; until: number }>();

export class FedexCarrier implements ShippingCarrier {
  readonly code = "FEDEX" as const;
  private readonly base: string;
  constructor(
    private readonly creds: FedexCredentials,
    mode: CarrierMode,
    private readonly fetchImpl: FetchLike,
    baseOverride?: string | null
  ) {
    this.base = trimBase(baseOverride || (mode === "LIVE" ? FEDEX_LIVE_URL : FEDEX_TEST_URL));
  }

  private async token(force = false): Promise<string> {
    const key = `${this.base}|${this.creds.apiKey}`;
    const hit = tokens.get(key);
    if (!force && hit && hit.until > Date.now()) return hit.token;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.creds.apiKey, client_secret: this.creds.secretKey }).toString();
    const r = await carrierRequest("FEDEX", this.fetchImpl, `${this.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const t = r.json?.access_token;
    if (!r.ok || typeof t !== "string") throw new CarrierError("auth", "FedEx refused the API key / secret.", "FEDEX");
    const ttl = Math.max(60, Number(r.json?.expires_in) || 3600);
    tokens.set(key, { token: t, until: Date.now() + (ttl - 60) * 1000 });
    return t;
  }

  private async post(path: string, body: unknown) {
    const send = async (tok: string) =>
      carrierRequest("FEDEX", this.fetchImpl, this.base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, "X-locale": "en_US" },
        body: JSON.stringify(body),
      });
    let r;
    try {
      r = await send(await this.token());
    } catch (e) {
      // التوكن اتلغى قبل ميعاده: مرة كمان بتوكن جديد
      if (e instanceof CarrierError && e.kind === "auth") r = await send(await this.token(true));
      else throw e;
    }
    if (!r.ok) {
      const msg = Array.isArray(r.json?.errors) ? r.json.errors.map((x: any) => x?.message || x?.code).filter(Boolean).join(" · ") : "";
      throw new CarrierError("bad_request", `FedEx: ${msg || `request failed (${r.status})`}`, "FEDEX");
    }
    return r.json;
  }

  private address(a: ShipAddress) {
    return {
      streetLines: [a.line1, a.line2].filter(Boolean),
      city: a.city,
      stateOrProvinceCode: a.state || undefined,
      postalCode: a.postalCode || undefined,
      countryCode: a.country,
    };
  }

  private packageItem(req: RateRequest) {
    return {
      weight: { units: "KG", value: round2(Math.max(0.1, req.parcel.weightKg)) },
      dimensions: { length: Math.ceil(req.parcel.lengthCm), width: Math.ceil(req.parcel.widthCm), height: Math.ceil(req.parcel.heightCm), units: "CM" },
    };
  }

  rateBody(req: RateRequest) {
    const intl = req.origin.country !== req.destination.country;
    return {
      accountNumber: { value: this.creds.accountNumber },
      rateRequestControlParameters: { returnTransitTimes: true },
      requestedShipment: {
        shipper: { address: this.address(req.origin) },
        recipient: { address: { ...this.address(req.destination), residential: true } },
        shipDateStamp: req.shipDate.toISOString().slice(0, 10),
        pickupType: "DROPOFF_AT_FEDEX_LOCATION",
        rateRequestType: ["ACCOUNT", "LIST"],
        packagingType: "YOUR_PACKAGING",
        ...(intl ? { customsClearanceDetail: { dutiesPayment: { paymentType: "SENDER" }, commodities: [this.commodity(req, "Goods", 1)] } } : {}),
        requestedPackageLineItems: [this.packageItem(req)],
      },
    };
  }

  private commodity(req: RateRequest, description: string, quantity: number) {
    return {
      description: description.slice(0, 100),
      countryOfManufacture: req.origin.country,
      quantity: Math.max(1, quantity),
      quantityUnits: "PCS",
      weight: { units: "KG", value: round2(Math.max(0.1, req.parcel.weightKg)) },
      customsValue: { amount: round2(req.declaredValue.amount), currency: req.declaredValue.currency },
    };
  }

  async quoteRates(req: RateRequest): Promise<CarrierRate[]> {
    const j = await this.post("/rate/v1/rates/quotes", this.rateBody(req));
    const details = Array.isArray(j?.output?.rateReplyDetails) ? j.output.rateReplyDetails : [];
    const out: CarrierRate[] = [];
    for (const d of details) {
      const rated = Array.isArray(d?.ratedShipmentDetails) ? d.ratedShipmentDetails : [];
      // سعر الحساب (ACCOUNT) لو موجود، وإلا LIST
      const pick = rated.find((x: any) => x?.rateType === "ACCOUNT") ?? rated[0];
      const amount = Number(pick?.totalNetCharge);
      const currency = String(pick?.currency ?? pick?.shipmentRateDetail?.currency ?? "").toUpperCase();
      if (!d?.serviceType || !Number.isFinite(amount) || amount <= 0 || !currency) continue;
      const transit = d?.commit?.transitDays?.minimumTransitTime ?? d?.operationalDetail?.transitTime;
      out.push({ service: String(d.serviceType), serviceName: String(d.serviceName || d.serviceType), amount, currency, estimatedDays: transitDays(transit) });
    }
    return out;
  }

  shipBody(req: ShipmentRequest) {
    const intl = req.origin.country !== req.destination.country;
    const party = (a: ShipAddress) => ({ contact: { personName: a.name, phoneNumber: digitsPhone(a.phone), emailAddress: a.email || undefined, companyName: a.company || undefined }, address: this.address(a) });
    return {
      labelResponseOptions: "LABEL",
      accountNumber: { value: this.creds.accountNumber },
      requestedShipment: {
        shipper: party(req.origin),
        recipients: [{ ...party(req.destination), address: { ...this.address(req.destination), residential: true } }],
        shipDatestamp: req.shipDate.toISOString().slice(0, 10),
        serviceType: req.service,
        packagingType: "YOUR_PACKAGING",
        pickupType: "DROPOFF_AT_FEDEX_LOCATION",
        blockInsightVisibility: false,
        shippingChargesPayment: { paymentType: "SENDER" },
        labelSpecification: { imageType: "PDF", labelStockType: "PAPER_85X11_TOP_HALF_LABEL" },
        ...(intl
          ? { customsClearanceDetail: { dutiesPayment: { paymentType: "RECIPIENT" }, isDocumentOnly: false, commodities: [this.commodity(req, req.description, req.pieces)] } }
          : {}),
        customerReferences: [{ customerReferenceType: "CUSTOMER_REFERENCE", value: req.reference.slice(0, 30) }],
        requestedPackageLineItems: [this.packageItem(req)],
      },
    };
  }

  async createShipment(req: ShipmentRequest): Promise<CreatedShipment> {
    const j = await this.post("/ship/v1/shipments", this.shipBody(req));
    const t = j?.output?.transactionShipments?.[0];
    const number = t?.masterTrackingNumber ?? t?.pieceResponses?.[0]?.trackingNumber;
    if (!number) throw new CarrierError("bad_request", "FedEx didn't return a tracking number.", "FEDEX");
    const doc = t?.pieceResponses?.[0]?.packageDocuments?.[0] ?? t?.shipmentDocuments?.[0];
    const pdf = typeof doc?.encodedLabel === "string" ? Buffer.from(doc.encodedLabel, "base64") : null;
    const url = typeof doc?.url === "string" && /^https:\/\//i.test(doc.url) ? doc.url : null;
    return { trackingNumber: String(number), service: req.service, labelPdf: pdf, labelUrl: url };
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const j = await this.post("/track/v1/trackingnumbers", { includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber } }] });
    const tr = j?.output?.completeTrackResults?.[0]?.trackResults?.[0];
    if (tr?.error) throw new CarrierError("bad_request", `FedEx: ${tr.error.message || tr.error.code}`, "FEDEX");
    const scans = Array.isArray(tr?.scanEvents) ? tr.scanEvents : [];
    const events: TrackingEvent[] = scans
      .map((e: any) => ({
        at: isoOr(e?.date),
        code: String(e?.derivedStatusCode || e?.eventType || ""),
        description: String(e?.eventDescription || e?.derivedStatus || ""),
        location: [e?.scanLocation?.city, e?.scanLocation?.countryCode].filter(Boolean).join(", ") || null,
      }))
      .sort((a: TrackingEvent, b: TrackingEvent) => b.at.localeCompare(a.at));
    const code = String(tr?.latestStatusDetail?.code ?? events[0]?.code ?? "");
    return { status: fedexStatus(code), events };
  }

  async validateCredentials(): Promise<void> {
    // المفتاح + السر صح = FedEx بيدّي توكن. رقم الحساب بيتأكد في أول سعر
    await this.token(true);
  }
}

function isoOr(v: unknown): string {
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function transitDays(v: unknown): number | null {
  const map: Record<string, number> = { ONE_DAY: 1, TWO_DAYS: 2, THREE_DAYS: 3, FOUR_DAYS: 4, FIVE_DAYS: 5, SIX_DAYS: 6, SEVEN_DAYS: 7 };
  return typeof v === "string" && map[v] ? map[v] : null;
}
