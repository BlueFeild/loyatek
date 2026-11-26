import { describe, expect, it } from "vitest";
import {
  applyFree,
  cartParcel,
  DEFAULT_PACKAGE,
  legacyMethods,
  matchZone,
  methodsSchema,
  pickOption,
  rateToUsd,
  readShippingMethods,
  shippingOptions,
  withMarkup,
  type CarrierQuoteResult,
  type ShippingMethod,
} from "../modules/store/shipping/shipping.logic";
import { quoteCart, type ProductForPricing } from "../modules/store/store-pricing.logic";
import { AramexCarrier, aramexStatus, parseAramexDate } from "../modules/store/shipping/aramex.gateway";
import { FedexCarrier, fedexStatus } from "../modules/store/shipping/fedex.gateway";
import { DhlCarrier, dhlStatus } from "../modules/store/shipping/dhl.gateway";
import { FakeCarrier } from "../modules/store/shipping/fake.carrier";
import { ShippingService } from "../modules/store/shipping/shipping.service";
import { CarrierError, type FetchLike, type RateRequest } from "../modules/store/shipping/shipping.types";
import { credentialSchemas } from "../modules/store/shipping/carrier.factory";

const legacyCfg = { deliveryEnabled: true, deliveryFee: 5, freeDeliveryOver: 100, areas: [], pickupEnabled: true };

describe("shipping methods: legacy conversion + schema", () => {
  it("old delivery settings become LOCAL + PICKUP (same fee / free-over)", () => {
    const m = legacyMethods({ ...legacyCfg, areas: [{ name: "Doha", fee: 3, freeOver: null }] }, "Mall");
    expect(m.map((x) => x.type)).toEqual(["LOCAL", "PICKUP"]);
    expect(m[0]).toMatchObject({ id: "local", fee: 5, freeOver: 100, areas: [{ name: "Doha", fee: 3 }] });
    expect(readShippingMethods(null, legacyCfg, null).legacy).toBe(true);
    expect(readShippingMethods([], legacyCfg, null)).toEqual({ methods: [], legacy: false });
  });
  it("schema: carrier needs a known carrier, duplicate ids refused, countries upper-cased", () => {
    const ok = methodsSchema.safeParse([{ id: "intl", type: "CARRIER", label: "DHL", carrier: "DHL", countries: ["ae", "SA"] }]);
    expect(ok.success && ok.data[0].type === "CARRIER" && ok.data[0].countries).toEqual(["AE", "SA"]);
    expect(methodsSchema.safeParse([{ id: "x", type: "CARRIER", label: "U", carrier: "UPS" }]).success).toBe(false);
    expect(methodsSchema.safeParse([{ id: "a", type: "FLAT", label: "A", fee: 1 }, { id: "a", type: "PICKUP", label: "B" }]).success).toBe(false);
    expect(methodsSchema.safeParse([{ id: "a", type: "FLAT", label: "A", fee: -1 }]).success).toBe(false);
  });
});

describe("zone matching", () => {
  const zones = [
    { name: "GCC", countries: ["AE", "SA", "KW"], cities: [], areas: [], fee: 30, freeOver: null },
    { name: "Doha", countries: ["QA"], cities: ["Doha"], areas: [], fee: 10, freeOver: null },
    { name: "Qatar", countries: ["QA"], cities: [], areas: [], fee: 20, freeOver: null },
    { name: "West Bay", countries: ["QA"], cities: ["Doha"], areas: ["West Bay"], fee: 5, freeOver: null },
    { name: "World", countries: [], cities: [], areas: [], fee: 80, freeOver: null },
  ];
  it("most specific zone wins (area > city > country > all)", () => {
    expect(matchZone(zones, { country: "QA", city: "doha", area: "west bay" })?.name).toBe("West Bay");
    expect(matchZone(zones, { country: "QA", city: "Doha" })?.name).toBe("Doha");
    expect(matchZone(zones, { country: "QA", city: "Lusail" })?.name).toBe("Qatar");
    expect(matchZone(zones, { country: "AE", city: "Dubai" })?.name).toBe("GCC");
    expect(matchZone(zones, { country: "EG" })?.name).toBe("World");
    expect(matchZone(zones.slice(0, 3), { country: "EG" })).toBeNull();
  });
});

describe("fees: markup, free shipping, currency, weight", () => {
  it("markup % + handling", () => {
    expect(withMarkup(10, 10, 2)).toBe(13);
    expect(withMarkup(10, 0, 0)).toBe(10);
  });
  it("free over an amount / coupon", () => {
    expect(applyFree(10, 100, 120, false)).toEqual({ fee: 0, free: "threshold" });
    expect(applyFree(10, 100, 50, true)).toEqual({ fee: 0, free: "coupon" });
    expect(applyFree(10, null, 50, false)).toEqual({ fee: 10, free: null });
  });
  it("carrier currency → USD (unknown currency = dropped)", () => {
    expect(rateToUsd(36.4, "QAR", () => true, () => 3.64)).toBe(10);
    expect(rateToUsd(10, "XYZ", () => false, () => 1)).toBeNull();
  });
  it("cart weight: product weight or default + box", () => {
    const p = cartParcel([{ productId: "a", qty: 2 }, { productId: "b", qty: 1 }], new Map([["a", 1.5], ["b", null]]), DEFAULT_PACKAGE);
    expect(p.weightKg).toBeCloseTo(3 + 0.5 + 0.2);
    expect(p.lengthCm).toBe(30);
  });
});

describe("options + selection", () => {
  const methods = methodsSchema.parse([
    { id: "local", type: "LOCAL", label: "Delivery", fee: 5, areas: [{ name: "Doha", fee: 3 }, { name: "Wakra", fee: 6, freeOver: 50 }] },
    { id: "pickup", type: "PICKUP", label: "Pickup" },
    { id: "gcc", type: "FLAT", label: "GCC", fee: 20, countries: ["AE"] },
    { id: "free", type: "FREE", label: "Free", minOrder: 200 },
    { id: "dhl", type: "CARRIER", label: "DHL", carrier: "DHL", markupPct: 10, handlingFee: 1, services: ["P"] },
  ]) as ShippingMethod[];
  const rates = new Map<string, CarrierQuoteResult>([["dhl", { ok: true, rates: [{ service: "P", serviceName: "Express", amount: 36.4, currency: "QAR", usd: 10 }, { service: "N", serviceName: "Domestic", amount: 1, currency: "QAR", usd: 0.3 }] }]]);

  it("lists what fits the address, carrier price with markup, only allowed services", () => {
    const r = shippingOptions(methods, { country: "QA", city: "Doha", area: "Wakra" }, 60, false, rates);
    expect(r.options.map((o) => o.id)).toEqual(["local", "pickup", "dhl:P"]);
    expect(r.options.find((o) => o.id === "local")).toMatchObject({ fee: 0, free: "threshold", area: "Wakra" });
    expect(r.options.find((o) => o.id === "dhl:P")).toMatchObject({ fee: 12, carrier: "DHL", service: "P" });
    expect(r.unavailable.map((u) => u.methodId).sort()).toEqual(["free", "gcc"]);
  });
  it("local delivery only inside the shop's own country", () => {
    const r = shippingOptions(methods, { country: "AE", city: "Dubai" }, 60, false, rates, "QA");
    expect(r.options.some((o) => o.id === "local")).toBe(false);
    expect(shippingOptions(methods, { country: "QA", city: "Doha", area: "Doha" }, 60, false, rates, "QA").options.some((o) => o.id === "local")).toBe(true);
  });
  it("carrier down → only that option disappears", () => {
    const r = shippingOptions(methods, { country: "QA", city: "Doha", area: "Doha" }, 60, false, new Map([["dhl", { ok: false, reason: "Not available right now" }]]));
    expect(r.options.map((o) => o.id)).toEqual(["local", "pickup"]);
  });
  it("selection must be a current option; area required; old clients still work", () => {
    const r = shippingOptions(methods, { country: "QA", city: "Doha" }, 300, false, rates);
    expect(() => pickOption(r, "local", null)).toThrow(/delivery area/);
    expect(() => pickOption(r, "gcc", null)).toThrow(/isn't available/);
    expect(pickOption(r, "free", null).fee).toBe(0);
    expect(pickOption(r, null, "PICKUP").type).toBe("PICKUP");
    expect(() => pickOption(r, "dhl:N", null)).toThrow();
  });
  it("quoteCart uses the shipping resolver after the coupon", () => {
    const product: ProductForPricing = { id: "p", name: "Shirt", type: "simple", sku: null, stock: null, backorders: false, active: true, categoryIds: [], coverPhotoId: null, purchaseNote: null, attrs: [], variations: [], price: 50, salePrice: null, saleStart: null, saleEnd: null };
    const q = quoteCart({
      lines: [{ productId: "p", qty: 1 }],
      products: [product],
      delivery: { ...legacyCfg, deliveryEnabled: false },
      tax: { enabled: false, rate: 0, inclusive: true, onShipping: false, label: null },
      fulfillment: "DELIVERY",
      now: new Date(),
      fmt: String,
      shipping: (goods) => ({ fee: goods > 40 ? 7 : 9, area: null, free: null }),
    });
    expect(q.deliveryFee).toBe(7);
    expect(q.total).toBe(57);
  });
});

// ---------- الـ gateways: شكل الطلب اللي بيتبعت (من غير شبكة) ----------
function recorder(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key] : { status: 404, body: {} };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  return { f, calls };
}
const sample: RateRequest = {
  origin: { name: "Shop", phone: "+974 5555 1234", line1: "Street 1", city: "Doha", country: "QA" },
  destination: { name: "Sara", phone: "+971500000000", line1: "Villa 3", city: "Dubai", country: "AE", postalCode: null },
  parcel: { weightKg: 1.25, lengthCm: 30, widthCm: 20, heightCm: 10 },
  declaredValue: { amount: 80, currency: "USD" },
  shipDate: new Date("2026-11-27T08:00:00Z"),
};

describe("Aramex gateway", () => {
  const creds = { username: "u@x.com", password: "p", accountNumber: "20016", accountPin: "331421", accountEntity: "DOH", accountCountryCode: "QA" };
  it("CalculateRate body has ClientInfo + EXP products, reads TotalAmount", async () => {
    const { f, calls } = recorder({ CalculateRate: { body: { HasErrors: false, TotalAmount: { CurrencyCode: "QAR", Value: 120.5 } } } });
    const rates = await new AramexCarrier(creds, "TEST", f).quoteRates(sample);
    expect(calls[0].url).toBe("https://ws.dev.aramex.net/ShippingAPI.V2/RateCalculator/Service_1_0.svc/json/CalculateRate");
    const b = JSON.parse(calls[0].body!);
    expect(b.ClientInfo).toMatchObject({ UserName: "u@x.com", AccountNumber: "20016", AccountPin: "331421", AccountEntity: "DOH", AccountCountryCode: "QA", Version: "v1.0" });
    expect(b.ShipmentDetails).toMatchObject({ ProductGroup: "EXP", ProductType: "PPX", ActualWeight: { Unit: "KG", Value: 1.25 } });
    expect(rates.map((r) => r.service)).toEqual(["PPX", "EPX"]);
    expect(rates[0]).toMatchObject({ amount: 120.5, currency: "QAR" });
  });
  it("CreateShipments → ID + label URL; live URL when LIVE", async () => {
    const { f, calls } = recorder({ CreateShipments: { body: { HasErrors: false, Shipments: [{ ID: "44001", HasErrors: false, ShipmentLabel: { LabelURL: "https://ws.aramex.net/label/44001.pdf" } }] } } });
    const s = await new AramexCarrier(creds, "LIVE", f).createShipment({ ...sample, service: "PPX", description: "Shirt", reference: "#7", pieces: 2 });
    expect(calls[0].url.startsWith("https://ws.aramex.net/ShippingAPI.V2/Shipping/")).toBe(true);
    const b = JSON.parse(calls[0].body!);
    expect(b.Shipments[0].ShippingDateTime).toMatch(/^\/Date\(\d+\)\/$/);
    expect(b.Shipments[0].Consignee.PartyAddress.CountryCode).toBe("AE");
    expect(b.LabelInfo).toEqual({ ReportID: 9201, ReportType: "URL" });
    expect(s).toMatchObject({ trackingNumber: "44001", labelUrl: "https://ws.aramex.net/label/44001.pdf" });
  });
  it("tracking codes + dates", async () => {
    expect(aramexStatus("SH005", "Delivered")).toBe("DELIVERED");
    expect(aramexStatus("SH003", "Out for Delivery")).toBe("OUT_FOR_DELIVERY");
    expect(aramexStatus("SH047", "Record created")).toBe("PENDING");
    expect(parseAramexDate("/Date(1764230400000+0300)/")).toBe(new Date(1764230400000).toISOString());
    const { f } = recorder({ TrackShipments: { body: { HasErrors: false, TrackingResults: [{ Key: "44001", Value: [{ UpdateCode: "SH005", UpdateDescription: "Delivered", UpdateDateTime: "/Date(1764230400000)/", UpdateLocation: "Dubai" }] }] } } });
    expect((await new AramexCarrier(creds, "TEST", f).track("44001")).status).toBe("DELIVERED");
  });
  it("auth problem in Notifications → CarrierError auth", async () => {
    const { f } = recorder({ CalculateRate: { body: { HasErrors: true, Notifications: [{ Code: "ERR01", Message: "Invalid username or password" }] } } });
    await expect(new AramexCarrier(creds, "TEST", f).quoteRates(sample)).rejects.toMatchObject({ kind: "auth" });
  });
  it("credential schema", () => {
    expect(credentialSchemas.ARAMEX.safeParse({ ...creds, accountCountryCode: "qa" }).success).toBe(true);
    expect(credentialSchemas.ARAMEX.safeParse({ ...creds, accountPin: "" }).success).toBe(false);
  });
});

describe("FedEx gateway", () => {
  const creds = { apiKey: "k", secretKey: "s", accountNumber: "740561073" };
  it("OAuth form + bearer, rates body, ACCOUNT rate picked", async () => {
    const { f, calls } = recorder({
      "/oauth/token": { body: { access_token: "TOK", expires_in: 3600 } },
      "/rate/v1/rates/quotes": {
        body: { output: { rateReplyDetails: [{ serviceType: "INTERNATIONAL_PRIORITY", serviceName: "FedEx International Priority", ratedShipmentDetails: [{ rateType: "LIST", totalNetCharge: 90, currency: "USD" }, { rateType: "ACCOUNT", totalNetCharge: 70.5, currency: "USD" }], commit: { transitDays: { minimumTransitTime: "TWO_DAYS" } } }] } },
      },
    });
    const rates = await new FedexCarrier({ ...creds, apiKey: "k-rates" }, "TEST", f).quoteRates(sample);
    expect(calls[0].url).toBe("https://apis-sandbox.fedex.com/oauth/token");
    expect(calls[0].body).toContain("grant_type=client_credentials");
    expect(calls[1].headers.Authorization).toBe("Bearer TOK");
    const b = JSON.parse(calls[1].body!);
    expect(b.accountNumber).toEqual({ value: "740561073" });
    expect(b.requestedShipment.requestedPackageLineItems[0].weight).toEqual({ units: "KG", value: 1.25 });
    expect(b.requestedShipment.customsClearanceDetail).toBeTruthy();
    expect(rates).toEqual([{ service: "INTERNATIONAL_PRIORITY", serviceName: "FedEx International Priority", amount: 70.5, currency: "USD", estimatedDays: 2 }]);
  });
  it("ship → tracking number + PDF label; track status codes", async () => {
    const { f, calls } = recorder({
      "/oauth/token": { body: { access_token: "TOK2" } },
      "/ship/v1/shipments": { body: { output: { transactionShipments: [{ masterTrackingNumber: "794953535000", pieceResponses: [{ packageDocuments: [{ encodedLabel: Buffer.from("%PDF").toString("base64") }] }] }] } } },
    });
    const s = await new FedexCarrier({ ...creds, apiKey: "k-ship" }, "LIVE", f).createShipment({ ...sample, service: "INTERNATIONAL_PRIORITY", description: "Shirt", reference: "#9", pieces: 1 });
    expect(calls[1].url).toBe("https://apis.fedex.com/ship/v1/shipments");
    expect(JSON.parse(calls[1].body!).labelResponseOptions).toBe("LABEL");
    expect(s.trackingNumber).toBe("794953535000");
    expect(s.labelPdf?.toString()).toBe("%PDF");
    expect(fedexStatus("DL")).toBe("DELIVERED");
    expect(fedexStatus("IT")).toBe("IN_TRANSIT");
  });
  it("bad key → auth", async () => {
    const { f } = recorder({ "/oauth/token": { status: 401, body: {} } });
    await expect(new FedexCarrier({ ...creds, apiKey: "bad" }, "TEST", f).validateCredentials()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("DHL gateway", () => {
  const creds = { apiKey: "dk", apiSecret: "ds", accountNumber: "123456789" };
  it("rates: basic auth + query, BILLC price", async () => {
    const { f, calls } = recorder({ "/rates": { body: { products: [{ productName: "EXPRESS WORLDWIDE", productCode: "P", totalPrice: [{ currencyType: "BILLC", priceCurrency: "QAR", price: 210 }, { currencyType: "PULCL", priceCurrency: "USD", price: 58 }], deliveryCapabilities: { totalTransitDays: "2" } }] } } });
    const rates = await new DhlCarrier(creds, "TEST", f).quoteRates(sample);
    expect(calls[0].url.startsWith("https://express.api.dhl.com/mydhlapi/test/rates?")).toBe(true);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("accountNumber")).toBe("123456789");
    expect(q.get("destinationCountryCode")).toBe("AE");
    expect(q.get("isCustomsDeclarable")).toBe("true");
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("dk:ds").toString("base64")}`);
    expect(rates).toEqual([{ service: "P", serviceName: "EXPRESS WORLDWIDE", amount: 210, currency: "QAR", estimatedDays: 2 }]);
  });
  it("shipment body + label; tracking", async () => {
    const { f, calls } = recorder({
      "/shipments/1234567890/tracking": { body: { shipments: [{ events: [{ date: "2026-11-28", time: "10:00:00", GMTOffset: "+04:00", typeCode: "OK", description: "Delivered", serviceArea: [{ description: "Dubai-AE" }] }] }] } },
      "/shipments": { body: { shipmentTrackingNumber: "1234567890", documents: [{ typeCode: "label", imageFormat: "PDF", content: Buffer.from("%PDF-dhl").toString("base64") }] } },
    });
    const c = new DhlCarrier(creds, "LIVE", f);
    const s = await c.createShipment({ ...sample, service: "P", description: "Shirt", reference: "#3", pieces: 1 });
    const b = JSON.parse(calls[0].body!);
    expect(calls[0].url).toBe("https://express.api.dhl.com/mydhlapi/shipments");
    expect(b.accounts).toEqual([{ typeCode: "shipper", number: "123456789" }]);
    expect(b.content).toMatchObject({ isCustomsDeclarable: true, declaredValue: 80, declaredValueCurrency: "USD", unitOfMeasurement: "metric" });
    expect(b.plannedShippingDateAndTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00 GMT\+00:00$/);
    expect(s.labelPdf?.toString()).toBe("%PDF-dhl");
    const t = await c.track("1234567890");
    expect(t.status).toBe("DELIVERED");
    expect(t.events[0]).toMatchObject({ at: "2026-11-28T06:00:00.000Z", location: "Dubai-AE" });
    expect(dhlStatus("WC", "")).toBe("OUT_FOR_DELIVERY");
  });
});

// ---------- الخدمة: كاش الأسعار، شركة واقعة، إنشاء شحنة مرة واحدة ----------
function fakeRepo() {
  const settings: any = {
    tenantId: "t1",
    deliveryEnabled: true,
    deliveryFee: 5,
    freeDeliveryOver: null,
    deliveryAreas: null,
    pickupEnabled: false,
    pickupAddress: null,
    shippingMethods: [{ id: "dhl", type: "CARRIER", label: "DHL", carrier: "DHL" }],
    shippingOrigin: { name: "Shop", phone: "+97455551234", line1: "Street 1", city: "Doha", country: "QA" },
    shippingPackage: null,
  };
  const shipments = new Map<string, any>();
  const order: any = { id: "o1", tenantId: "t1", number: 7, status: "NEW", fulfillment: "DELIVERY", address: "Villa 3, Palm", customerName: "Sara", customerPhone: "+971500000000", customerEmail: null, shippingCarrier: "DHL", shippingService: "EXPRESS", shippingCountry: "AE", shippingCity: "Dubai", shippingPostalCode: null, area: null, subtotal: 80, discount: 0, items: [{ productId: "p", name: "Shirt", qty: 1 }] };
  return {
    order,
    shipments,
    repo: {
      settings: async () => settings,
      saveSettings: async (_t: string, d: any) => Object.assign(settings, d),
      accounts: async () => [{ carrier: "DHL", enabled: true, mode: "TEST", credentials: "sealed", accountHint: "6789", lastCheckedAt: null, lastError: null }],
      account: async () => ({ carrier: "DHL", enabled: true, mode: "TEST", credentials: "sealed" }),
      productWeights: async () => [{ id: "p", weightKg: 1 }],
      order: async (_t: string, id: string) => (id === "o1" ? order : null),
      shipment: async (_t: string, id: string) => shipments.get(id) ?? null,
      claimShipment: async (_t: string, id: string, carrier: string, service: string) => {
        const cur = shipments.get(id);
        if (cur && cur.status !== "FAILED") return false;
        shipments.set(id, { orderId: id, carrier, service, status: "CREATING", mode: "TEST", trackingEvents: [], createdAt: new Date() });
        return true;
      },
      shipmentCreated: async (_t: string, id: string, d: any) => Object.assign(shipments.get(id), d, { status: "CREATED", trackingStatus: "PENDING" }),
      shipmentFailed: async (_t: string, id: string, e: string) => Object.assign(shipments.get(id), { status: "FAILED", error: e }),
      markOrderShipped: async () => {
        if (order.status === "NEW") order.status = "SHIPPED";
      },
      markOrderDelivered: async () => {
        order.status = "DELIVERED";
      },
      saveTracking: async (_t: string, id: string, d: any) => Object.assign(shipments.get(id), d),
      trackingFailed: async () => undefined,
    } as any,
  };
}
const sealer = { seal: (s: string) => s, open: () => JSON.stringify({ apiKey: "k", apiSecret: "s", accountNumber: "123456789" }) };
const ratesPort = { supported: (c: string) => ["USD", "QAR"].includes(c), rateFor: async (c: string) => (c === "QAR" ? 3.64 : 1) };

describe("ShippingService", () => {
  it("live rates are cached, converted to USD, and a down carrier just hides the option", async () => {
    const { repo } = fakeRepo();
    const fake = new FakeCarrier("DHL", 10, "QAR");
    const svc = new ShippingService(repo, () => fake, sealer, ratesPort);
    const s = await repo.settings();
    const { methods } = svc.methodsOf(s);
    const input = { lines: [{ productId: "p", qty: 1 }], weights: new Map([["p", 1]]), dest: { country: "AE", city: "Dubai" }, declaredUsd: 80 };
    const a = await svc.carrierRates("t1", s, methods, input);
    const b = await svc.carrierRates("t1", s, methods, input);
    expect(fake.quotes).toBe(1);
    const r = a.get("dhl");
    expect(r?.ok && r.rates.map((x) => x.usd)).toEqual([Math.round((2 * (20 + 1.2 * 10) / 3.64) * 1e6) / 1e6, Math.round(((20 + 1.2 * 10) / 3.64) * 1e6) / 1e6]);
    expect(b.get("dhl")).toEqual(r);
    const down = new FakeCarrier("DHL");
    down.failQuotes = new CarrierError("unavailable", "timeout");
    const svc2 = new ShippingService(repo, () => down, sealer, ratesPort);
    expect(await svc2.carrierRates("t1", s, methods, input)).toEqual(new Map([["dhl", { ok: false, reason: "Not available right now" }]]));
  });
  it("create shipment once: second click → 409, order SHIPPED, delivered tracking → DELIVERED", async () => {
    const { repo, order, shipments } = fakeRepo();
    const fake = new FakeCarrier("DHL");
    const svc = new ShippingService(repo, () => fake, sealer, ratesPort);
    const [x, y] = await Promise.allSettled([svc.createShipment("t1", "o1", {}), svc.createShipment("t1", "o1", {})]);
    expect([x.status, y.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(fake.created.length).toBe(1);
    expect(fake.created[0]).toMatchObject({ service: "EXPRESS", reference: "#7", destination: { country: "AE", city: "Dubai" } });
    expect(order.status).toBe("SHIPPED");
    expect(shipments.get("o1").trackingNumber).toBe("FAKE1001");
    fake.trackStatus = { status: "DELIVERED", events: [{ at: "2026-11-28T06:00:00.000Z", code: "OK", description: "Delivered" }] };
    const v = await svc.refreshTracking("t1", "o1");
    expect(v?.trackingStatus).toBe("DELIVERED");
    expect(order.status).toBe("DELIVERED");
  });
  it("carrier refuses → shipment FAILED (can retry), error mapped", async () => {
    const { repo, shipments } = fakeRepo();
    const fake = new FakeCarrier("DHL");
    fake.createShipment = async () => {
      throw new CarrierError("bad_request", "DHL: bad postal code");
    };
    const svc = new ShippingService(repo, () => fake, sealer, ratesPort);
    await expect(svc.createShipment("t1", "o1", {})).rejects.toMatchObject({ status: 400, code: "CARRIER_REFUSED" });
    expect(shipments.get("o1").status).toBe("FAILED");
  });
});
