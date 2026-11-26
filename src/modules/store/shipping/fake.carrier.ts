import { CarrierError, type CarrierCode, type CarrierRate, type CreatedShipment, type RateRequest, type ShipmentRequest, type ShippingCarrier, type TrackingResult } from "./shipping.types";

// شركة شحن وهمية للاختبارات (unit) - بتحسب سعر من الوزن، وبتعدّ الشحنات اللي اتعملت
export class FakeCarrier implements ShippingCarrier {
  created: ShipmentRequest[] = [];
  quotes = 0;
  failQuotes: CarrierError | null = null;
  delayMs = 0;
  trackStatus: TrackingResult = { status: "IN_TRANSIT", events: [{ at: new Date(0).toISOString(), code: "PU", description: "Picked up", location: "Doha" }] };
  constructor(
    readonly code: CarrierCode = "DHL",
    private readonly perKg = 10,
    private readonly currency = "QAR"
  ) {}

  async quoteRates(req: RateRequest): Promise<CarrierRate[]> {
    this.quotes++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failQuotes) throw this.failQuotes;
    const base = Math.round((20 + req.parcel.weightKg * this.perKg) * 100) / 100;
    return [
      { service: "EXPRESS", serviceName: "Express", amount: base * 2, currency: this.currency, estimatedDays: 1 },
      { service: "ECONOMY", serviceName: "Economy", amount: base, currency: this.currency, estimatedDays: 4 },
    ];
  }
  async createShipment(req: ShipmentRequest): Promise<CreatedShipment> {
    this.created.push(req);
    return { trackingNumber: `FAKE${1000 + this.created.length}`, service: req.service, labelPdf: Buffer.from("%PDF-1.4 fake label"), labelUrl: null };
  }
  async track(): Promise<TrackingResult> {
    return this.trackStatus;
  }
  async validateCredentials(): Promise<void> {
    if (this.failQuotes?.kind === "auth") throw this.failQuotes;
  }
}
