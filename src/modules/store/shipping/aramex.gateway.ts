import { carrierRequest, digitsPhone, round2, trimBase } from "./carrier-http";
import {
  CarrierError,
  type AramexCredentials,
  type CarrierMode,
  type CarrierRate,
  type CreatedShipment,
  type FetchLike,
  type RateRequest,
  type ShipAddress,
  type ShipmentRequest,
  type ShippingCarrier,
  type TrackingEvent,
  type TrackingResult,
  type TrackingStatus,
} from "./shipping.types";

// Aramex "Shipping Services API" (WCF بـ JSON endpoints) - المرجع:
//   https://www.aramex.com/developers-solution-center/aramex-apis  (Rates Calculator / Shipping Services / Shipments Tracking)
//   الدليل: "Shipping Services API Manual" + "Rate Calculator API Manual" + "Shipments Tracking API Manual" (PDF من Aramex Developers)
// العناوين: live = https://ws.aramex.net/ShippingAPI.V2 ، test = https://ws.dev.aramex.net/ShippingAPI.V2
//   (Aramex بيدّي التاجر بيانات حساب التجربة مع رابط التجربة - لو اختلف، ARAMEX_BASE_URL بيغيّره)
// ⚠️ اللي مااتأكدش ضد Aramex الحقيقي (من غير حساب): أكواد ProductType لكل دولة (ONP/PPX/EPX)، شكل التاريخ "/Date(ms)/"،
//    رقم تقرير البوليصة 9201، وأكواد التتبع (SH005 = اتسلّم). كلها هنا بس في الملف ده.
export const ARAMEX_LIVE_URL = "https://ws.aramex.net/ShippingAPI.V2";
export const ARAMEX_TEST_URL = "https://ws.dev.aramex.net/ShippingAPI.V2";

const PATHS = {
  rate: "/RateCalculator/Service_1_0.svc/json/CalculateRate",
  ship: "/Shipping/Service_1_0.svc/json/CreateShipments",
  track: "/Tracking/Service_1_0.svc/json/TrackShipments",
};

// منتجات Aramex: محلي (DOM) = ONP (Overnight Parcel)، دولي (EXP) = PPX (Priority Parcel Express) / EPX (Economy Parcel Express)
const DOM_PRODUCTS = [{ code: "ONP", name: "Aramex Domestic (overnight)" }];
const EXP_PRODUCTS = [
  { code: "PPX", name: "Aramex Priority Express" },
  { code: "EPX", name: "Aramex Economy Express" },
];

const aramexDate = (d: Date) => `/Date(${d.getTime()})/`;
export function parseAramexDate(v: unknown): string {
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v ?? ""));
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function notificationsText(n: unknown): string {
  if (!Array.isArray(n)) return "";
  return n.map((x) => [x?.Code, x?.Message].filter(Boolean).join(": ")).filter(Boolean).join(" · ");
}

// أكواد Aramex (من دليل التتبع): SH005 / SH006 = اتسلّم، SH003 = طلع للتوصيل، SH008 / SH033 ... = مشكلة
export function aramexStatus(code: string, description: string): TrackingStatus {
  const c = (code || "").toUpperCase();
  const d = (description || "").toLowerCase();
  if (c === "SH005" || c === "SH006" || (/deliver/.test(d) && !/out for|attempt|not deliver|undeliver/.test(d))) return "DELIVERED";
  if (c === "SH003" || /out for delivery/.test(d)) return "OUT_FOR_DELIVERY";
  if (/attempt|exception|hold|return|refus|damag|undeliver|not deliver/.test(d)) return "EXCEPTION";
  if (c === "SH014" || /created|label|data received/.test(d)) return "PENDING";
  return "IN_TRANSIT";
}

export class AramexCarrier implements ShippingCarrier {
  readonly code = "ARAMEX" as const;
  private readonly base: string;
  constructor(
    private readonly creds: AramexCredentials,
    mode: CarrierMode,
    private readonly fetchImpl: FetchLike,
    baseOverride?: string | null
  ) {
    this.base = trimBase(baseOverride || (mode === "LIVE" ? ARAMEX_LIVE_URL : ARAMEX_TEST_URL));
  }

  clientInfo() {
    return {
      UserName: this.creds.username,
      Password: this.creds.password,
      Version: "v1.0",
      AccountNumber: this.creds.accountNumber,
      AccountPin: this.creds.accountPin,
      AccountEntity: this.creds.accountEntity,
      AccountCountryCode: this.creds.accountCountryCode,
      Source: 24,
    };
  }

  private address(a: ShipAddress) {
    return { Line1: a.line1, Line2: a.line2 ?? "", Line3: "", City: a.city, StateOrProvinceCode: a.state ?? "", PostCode: a.postalCode ?? "", CountryCode: a.country };
  }

  private products(req: RateRequest) {
    const domestic = req.origin.country === req.destination.country;
    return { group: domestic ? "DOM" : "EXP", list: domestic ? DOM_PRODUCTS : EXP_PRODUCTS };
  }

  rateBody(req: RateRequest, productType: string, group: string) {
    const w = { Unit: "KG", Value: round2(Math.max(0.1, req.parcel.weightKg)) };
    return {
      ClientInfo: this.clientInfo(),
      Transaction: { Reference1: "", Reference2: "", Reference3: "", Reference4: "", Reference5: "" },
      OriginAddress: this.address(req.origin),
      DestinationAddress: this.address(req.destination),
      ShipmentDetails: {
        Dimensions: { Length: req.parcel.lengthCm, Width: req.parcel.widthCm, Height: req.parcel.heightCm, Unit: "CM" },
        ActualWeight: w,
        ChargeableWeight: w,
        DescriptionOfGoods: "Goods",
        GoodsOriginCountry: req.origin.country,
        NumberOfPieces: 1,
        ProductGroup: group,
        ProductType: productType,
        PaymentType: "P",
        PaymentOptions: "",
        CustomsValueAmount: group === "EXP" ? { CurrencyCode: req.declaredValue.currency, Value: round2(req.declaredValue.amount) } : null,
      },
      PreferredCurrencyCode: "",
    };
  }

  private async post(path: string, body: unknown) {
    const r = await carrierRequest("ARAMEX", this.fetchImpl, this.base + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    if (!r.json) throw new CarrierError("unavailable", "Aramex sent an answer we couldn't read.", "ARAMEX");
    return r.json;
  }

  async quoteRates(req: RateRequest): Promise<CarrierRate[]> {
    const { group, list } = this.products(req);
    const out: CarrierRate[] = [];
    let lastError = "";
    for (const p of list) {
      const j = await this.post(PATHS.rate, this.rateBody(req, p.code, group));
      if (j.HasErrors) {
        lastError = notificationsText(j.Notifications);
        if (/auth|password|user ?name|account pin|invalid account/i.test(lastError)) throw new CarrierError("auth", `Aramex: ${lastError}`, "ARAMEX");
        continue;
      }
      const amount = Number(j?.TotalAmount?.Value);
      const currency = String(j?.TotalAmount?.CurrencyCode ?? "").toUpperCase();
      if (Number.isFinite(amount) && amount > 0 && currency) out.push({ service: p.code, serviceName: p.name, amount, currency, estimatedDays: null });
    }
    if (!out.length && lastError) throw new CarrierError("bad_request", `Aramex: ${lastError}`, "ARAMEX");
    return out;
  }

  shipBody(req: ShipmentRequest) {
    const { group } = this.products(req);
    const party = (a: ShipAddress, withAccount: boolean) => ({
      Reference1: req.reference,
      AccountNumber: withAccount ? this.creds.accountNumber : "",
      PartyAddress: this.address(a),
      Contact: { PersonName: a.name, CompanyName: a.company || a.name, PhoneNumber1: digitsPhone(a.phone), CellPhone: digitsPhone(a.phone), EmailAddress: a.email ?? "" },
    });
    const w = { Unit: "KG", Value: round2(Math.max(0.1, req.parcel.weightKg)) };
    return {
      ClientInfo: this.clientInfo(),
      LabelInfo: { ReportID: 9201, ReportType: "URL" },
      Shipments: [
        {
          Reference1: req.reference,
          Shipper: party(req.origin, true),
          Consignee: party(req.destination, false),
          ShippingDateTime: aramexDate(req.shipDate),
          DueDate: aramexDate(new Date(req.shipDate.getTime() + 3 * 86400_000)),
          Details: {
            Dimensions: { Length: req.parcel.lengthCm, Width: req.parcel.widthCm, Height: req.parcel.heightCm, Unit: "CM" },
            ActualWeight: w,
            ChargeableWeight: w,
            DescriptionOfGoods: req.description.slice(0, 100),
            GoodsOriginCountry: req.origin.country,
            NumberOfPieces: Math.max(1, req.pieces),
            ProductGroup: group,
            ProductType: req.service,
            PaymentType: "P",
            PaymentOptions: "",
            Services: "",
            CustomsValueAmount: group === "EXP" ? { CurrencyCode: req.declaredValue.currency, Value: round2(req.declaredValue.amount) } : null,
          },
        },
      ],
      Transaction: { Reference1: req.reference },
    };
  }

  async createShipment(req: ShipmentRequest): Promise<CreatedShipment> {
    const j = await this.post(PATHS.ship, this.shipBody(req));
    const s = Array.isArray(j.Shipments) ? j.Shipments[0] : null;
    if (j.HasErrors || !s || s.HasErrors || !s.ID) {
      const msg = notificationsText(s?.Notifications) || notificationsText(j.Notifications) || "Aramex didn't create the shipment.";
      throw new CarrierError(/auth|password|user ?name/i.test(msg) ? "auth" : "bad_request", `Aramex: ${msg}`, "ARAMEX");
    }
    const label = s.ShipmentLabel ?? {};
    const pdf = typeof label.LabelFileContents === "string" && label.LabelFileContents ? Buffer.from(label.LabelFileContents, "base64") : null;
    const url = typeof label.LabelURL === "string" && /^https:\/\//i.test(label.LabelURL) ? label.LabelURL : null;
    return { trackingNumber: String(s.ID), service: req.service, labelPdf: pdf, labelUrl: url };
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const j = await this.post(PATHS.track, { ClientInfo: this.clientInfo(), Shipments: [trackingNumber], GetLastTrackingUpdateOnly: false, Transaction: { Reference1: "" } });
    if (j.HasErrors) throw new CarrierError("bad_request", `Aramex: ${notificationsText(j.Notifications) || "tracking failed"}`, "ARAMEX");
    const results = Array.isArray(j.TrackingResults) ? j.TrackingResults : [];
    const mine = results.find((r: any) => String(r?.Key) === trackingNumber) ?? results[0];
    const raw = Array.isArray(mine?.Value) ? mine.Value : [];
    const events: TrackingEvent[] = raw
      .map((e: any) => ({ at: parseAramexDate(e?.UpdateDateTime), code: String(e?.UpdateCode ?? ""), description: String(e?.UpdateDescription ?? ""), location: e?.UpdateLocation ? String(e.UpdateLocation) : null }))
      .sort((a: TrackingEvent, b: TrackingEvent) => b.at.localeCompare(a.at));
    const latest = events[0];
    return { status: latest ? aramexStatus(latest.code, latest.description) : "PENDING", events };
  }

  async validateCredentials(sample: RateRequest): Promise<void> {
    // مفيش endpoint "مين أنا" في Aramex: بنحسب سعر شحنة تجريبية. لو المفاتيح غلط Aramex بيرجّع HasErrors برسالة
    const { group, list } = this.products(sample);
    const j = await this.post(PATHS.rate, this.rateBody(sample, list[0].code, group));
    if (j.HasErrors) throw new CarrierError("auth", `Aramex: ${notificationsText(j.Notifications) || "the account details were refused"}`, "ARAMEX");
  }
}
