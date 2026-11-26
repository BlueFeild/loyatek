import { Prisma } from "@prisma/client";
import { AppError, NotFoundError } from "../../../core/errors";
import { round6 } from "../store-catalog.logic";
import type { DeliveryConfig } from "../store-pricing.logic";
import { accountHint, credentialSchemas, type CarrierFactory } from "./carrier.factory";
import {
  cartParcel,
  methodsSchema,
  needsAddressFields,
  originSchema,
  packageSchema,
  rateCacheKey,
  rateToUsd,
  readOrigin,
  readPackage,
  readShippingMethods,
  type CarrierQuoteResult,
  type Destination,
  type ShippingMethod,
  type ShippingOrigin,
  type ShippingPackage,
} from "./shipping.logic";
import type { ShippingRepository } from "./shipping.repository";
import {
  CARRIER_NAMES,
  CARRIERS,
  CarrierError,
  publicTrackingUrl,
  type CarrierCode,
  type CarrierMode,
  type RateRequest,
  type ShipAddress,
  type ShippingCarrier,
  type TrackingEvent,
  type TrackingStatus,
} from "./shipping.types";

// الشحن: طرق الشحن، حسابات الشركات (متشفّرة)، الأسعار اللحظية (كاش)، إنشاء الشحنة + البوليصة، والتتبع.
// بيعتمد على واجهات بس (repository / factory / sealer / rates) - فسهل نختبره بنسخ وهمية.

export interface Sealer {
  seal(plain: string): string;
  open(stored: string): string;
}
export interface RatesPort {
  supported(currency: string): boolean;
  rateFor(currency: string): Promise<number>;
}

type SettingsRow = Awaited<ReturnType<ShippingRepository["settings"]>>;
const num = (v: Prisma.Decimal | number | null | undefined) => (v == null ? null : Number(v));
const RATE_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;
const MAX_EVENTS = 50;

export interface CheckoutShippingInput {
  lines: { productId: string; qty: number }[];
  weights: Map<string, number | null>;
  dest: Destination;
  declaredUsd: number;
}

export class ShippingService {
  private cache = new Map<string, { at: number; ttl: number; value: CarrierQuoteResult }>();
  private inflight = new Map<string, Promise<CarrierQuoteResult>>();

  constructor(
    private readonly repo: ShippingRepository,
    private readonly carriers: CarrierFactory,
    private readonly sealer: Sealer,
    private readonly rates: RatesPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ====================== قراءة الإعدادات ======================
  legacyConfig(s: SettingsRow): DeliveryConfig {
    const areas = Array.isArray(s.deliveryAreas) ? (s.deliveryAreas as any[]) : [];
    return {
      deliveryEnabled: s.deliveryEnabled,
      deliveryFee: Number(s.deliveryFee),
      freeDeliveryOver: num(s.freeDeliveryOver),
      areas: areas.filter((a) => a && typeof a.name === "string").map((a) => ({ name: a.name, fee: Number(a.fee) || 0, freeOver: a.freeOver == null ? null : Number(a.freeOver) })),
      pickupEnabled: s.pickupEnabled,
    };
  }
  methodsOf(s: SettingsRow) {
    return readShippingMethods(s.shippingMethods, this.legacyConfig(s), s.pickupAddress);
  }

  async settingsView(tenantId: string) {
    const [s, accounts] = await Promise.all([this.repo.settings(tenantId), this.repo.accounts(tenantId)]);
    const { methods, legacy } = this.methodsOf(s);
    return {
      methods,
      legacy,
      origin: readOrigin(s.shippingOrigin),
      package: readPackage(s.shippingPackage),
      // المفاتيح نفسها مابترجعش أبدًا - بس "متوصّل · ••1234 · تجربة"
      carriers: CARRIERS.map((c) => {
        const a = accounts.find((x) => x.carrier === c);
        return {
          carrier: c,
          name: CARRIER_NAMES[c],
          connected: !!a,
          enabled: a?.enabled ?? false,
          mode: (a?.mode ?? null) as CarrierMode | null,
          accountHint: a?.accountHint ?? null,
          lastCheckedAt: a?.lastCheckedAt ?? null,
          lastError: a?.lastError ?? null,
        };
      }),
    };
  }

  async saveMethods(tenantId: string, raw: unknown) {
    const parsed = methodsSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Check the shipping methods");
    const accounts = await this.repo.accounts(tenantId);
    for (const m of parsed.data)
      if (m.type === "CARRIER" && m.enabled && !accounts.some((a) => a.carrier === m.carrier))
        throw new AppError(400, "CARRIER_NOT_CONNECTED", `Connect your ${CARRIER_NAMES[m.carrier]} account first.`);
    if (!parsed.data.some((m) => m.enabled)) throw new AppError(400, "NO_METHODS", "Keep at least one shipping method on — otherwise customers can't order.");
    await this.repo.saveSettings(tenantId, { shippingMethods: parsed.data as unknown as Prisma.InputJsonValue });
    return this.settingsView(tenantId);
  }
  // رجوع للطريقة القديمة (التوصيل بالمناطق + الاستلام)
  async resetMethods(tenantId: string) {
    await this.repo.saveSettings(tenantId, { shippingMethods: Prisma.DbNull });
    return this.settingsView(tenantId);
  }
  async saveOrigin(tenantId: string, raw: unknown) {
    const p = originSchema.safeParse(raw);
    if (!p.success) throw new AppError(400, "VALIDATION_ERROR", p.error.issues[0]?.message ?? "Check the address");
    await this.repo.saveSettings(tenantId, { shippingOrigin: p.data as unknown as Prisma.InputJsonValue });
    return this.settingsView(tenantId);
  }
  async savePackage(tenantId: string, raw: unknown) {
    const p = packageSchema.safeParse(raw ?? {});
    if (!p.success) throw new AppError(400, "VALIDATION_ERROR", p.error.issues[0]?.message ?? "Check the box size");
    await this.repo.saveSettings(tenantId, { shippingPackage: p.data as unknown as Prisma.InputJsonValue });
    return this.settingsView(tenantId);
  }

  // ====================== حسابات الشركات ======================
  private sampleRequest(origin: ShippingOrigin | null, fallbackCountry: string): RateRequest {
    const from: ShipAddress = origin
      ? { ...origin, company: origin.company ?? null }
      : { name: "Test", phone: "+97400000000", line1: "Test street", city: fallbackCountry === "QA" ? "Doha" : "City", country: fallbackCountry };
    return { origin: from, destination: { ...from, name: "Test receiver" }, parcel: { weightKg: 1, lengthCm: 20, widthCm: 15, heightCm: 10 }, declaredValue: { amount: 10, currency: "USD" }, shipDate: this.now() };
  }

  async connect(tenantId: string, carrier: CarrierCode, mode: CarrierMode, rawCreds: unknown) {
    const parsed = credentialSchemas[carrier].safeParse(rawCreds);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Check the account details");
    const creds = parsed.data as Record<string, string>;
    const s = await this.repo.settings(tenantId);
    const origin = readOrigin(s.shippingOrigin);
    const sample = this.sampleRequest(origin, creds.accountCountryCode || origin?.country || "QA");
    try {
      await this.carriers(carrier, creds, mode).validateCredentials(sample);
    } catch (e) {
      throw this.toAppError(e, carrier);
    }
    await this.repo.upsertAccount(tenantId, carrier, { mode, credentials: this.sealer.seal(JSON.stringify(creds)), accountHint: accountHint(creds.accountNumber), lastCheckedAt: this.now(), lastError: null });
    this.clearCache(tenantId);
    return this.settingsView(tenantId);
  }

  async testConnection(tenantId: string, carrier: CarrierCode) {
    const { client } = await this.client(tenantId, carrier);
    const s = await this.repo.settings(tenantId);
    const origin = readOrigin(s.shippingOrigin);
    try {
      await client.validateCredentials(this.sampleRequest(origin, origin?.country ?? "QA"));
      await this.repo.markAccountChecked(tenantId, carrier, null);
      return { ok: true as const, message: `${CARRIER_NAMES[carrier]} accepted your account ✓` };
    } catch (e) {
      const err = this.toAppError(e, carrier);
      await this.repo.markAccountChecked(tenantId, carrier, err.message);
      return { ok: false as const, message: err.message };
    }
  }

  async disconnect(tenantId: string, carrier: CarrierCode) {
    await this.repo.deleteAccount(tenantId, carrier);
    // طرق الشحن اللي على الشركة دي بتتقفل (مش بتتمسح)
    const s = await this.repo.settings(tenantId);
    const { methods, legacy } = this.methodsOf(s);
    if (!legacy && methods.some((m) => m.type === "CARRIER" && m.carrier === carrier && m.enabled)) {
      const next = methods.map((m) => (m.type === "CARRIER" && m.carrier === carrier ? { ...m, enabled: false } : m));
      await this.repo.saveSettings(tenantId, { shippingMethods: next as unknown as Prisma.InputJsonValue });
    }
    this.clearCache(tenantId);
    return this.settingsView(tenantId);
  }

  private async client(tenantId: string, carrier: CarrierCode): Promise<{ client: ShippingCarrier; mode: CarrierMode }> {
    const a = await this.repo.account(tenantId, carrier);
    if (!a || !a.enabled) throw new AppError(400, "CARRIER_NOT_CONNECTED", `Connect your ${CARRIER_NAMES[carrier]} account first (Settings → Shipping).`);
    let creds: unknown;
    try {
      creds = JSON.parse(this.sealer.open(a.credentials));
    } catch {
      throw new AppError(400, "CARRIER_RECONNECT", `Please connect your ${CARRIER_NAMES[carrier]} account again.`);
    }
    const mode = (a.mode === "LIVE" ? "LIVE" : "TEST") as CarrierMode;
    return { client: this.carriers(carrier, creds, mode), mode };
  }

  private toAppError(e: unknown, carrier: CarrierCode): AppError {
    if (e instanceof AppError) return e;
    if (e instanceof CarrierError) {
      if (e.kind === "auth") return new AppError(400, "CARRIER_AUTH", e.message.includes(CARRIER_NAMES[carrier]) || e.message.startsWith(carrier) ? e.message : `${CARRIER_NAMES[carrier]}: ${e.message}`);
      if (e.kind === "unavailable") return new AppError(503, "CARRIER_UNAVAILABLE", `${CARRIER_NAMES[carrier]} isn't answering right now. Please try again in a few minutes.`);
      return new AppError(400, "CARRIER_REFUSED", e.message);
    }
    return new AppError(502, "CARRIER_ERROR", `Something went wrong with ${CARRIER_NAMES[carrier]}.`);
  }

  // ====================== الأسعار اللحظية (للعميل) ======================
  clearCache(tenantId?: string) {
    if (!tenantId) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}|`)) this.cache.delete(k);
  }

  // كل طرق "شركة شحن" المفعّلة: سعر لحظي (كاش 5 دقايق، مهلة 8 ثواني). شركة واقعة = الطريقة دي بس بتختفي
  async carrierRates(tenantId: string, s: SettingsRow, methods: ShippingMethod[], input: CheckoutShippingInput): Promise<Map<string, CarrierQuoteResult>> {
    const out = new Map<string, CarrierQuoteResult>();
    const carrierMethods = methods.filter((m): m is Extract<ShippingMethod, { type: "CARRIER" }> => m.type === "CARRIER" && m.enabled);
    if (!carrierMethods.length) return out;
    const dest = input.dest;
    if (!dest.country || !dest.city?.trim()) return out;
    const origin = readOrigin(s.shippingOrigin);
    if (!origin) {
      for (const m of carrierMethods) out.set(m.id, { ok: false, reason: "Not available" });
      return out;
    }
    const pkg: ShippingPackage = readPackage(s.shippingPackage);
    const parcel = cartParcel(input.lines, input.weights, pkg);
    const accounts = await this.repo.accounts(tenantId);
    const destAddr: ShipAddress = { name: "Customer", phone: origin.phone, line1: "-", city: dest.city.trim(), postalCode: dest.postalCode ?? null, country: dest.country.toUpperCase() };
    const originAddr: ShipAddress = { ...origin };
    await Promise.all(
      [...new Set(carrierMethods.map((m) => m.carrier))].map(async (carrier) => {
        const a = accounts.find((x) => x.carrier === carrier && x.enabled);
        const mine = carrierMethods.filter((m) => m.carrier === carrier);
        if (!a) {
          for (const m of mine) out.set(m.id, { ok: false, reason: "Not available" });
          return;
        }
        const key = rateCacheKey(tenantId, carrier, a.mode, originAddr, dest, parcel, input.declaredUsd);
        const result = await this.cachedQuote(key, async () => {
          const { client } = await this.client(tenantId, carrier);
          const rates = await client.quoteRates({ origin: originAddr, destination: destAddr, parcel, declaredValue: { amount: round6(input.declaredUsd), currency: "USD" }, shipDate: this.now() });
          const withUsd = [];
          for (const r of rates) {
            // عملة الشركة → دولار بأسعار المنصة. عملة مش عندنا = الخدمة دي مابتظهرش
            const code = r.currency.toUpperCase();
            if (!this.rates.supported(code)) continue;
            const rate = await this.rates.rateFor(code);
            const value = rateToUsd(r.amount, code, () => true, () => rate);
            if (value != null) withUsd.push({ ...r, usd: value });
          }
          return { ok: true as const, rates: withUsd };
        });
        for (const m of mine) out.set(m.id, result);
      })
    );
    return out;
  }

  private async cachedQuote(key: string, fn: () => Promise<CarrierQuoteResult>): Promise<CarrierQuoteResult> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = fn()
      .catch((e): CarrierQuoteResult => {
        if (e instanceof CarrierError || e instanceof AppError) console.warn(`[shipping] live rate failed: ${(e as Error).message}`);
        else console.warn(`[shipping] live rate failed: ${(e as Error)?.message}`);
        return { ok: false, reason: "Not available right now" };
      })
      .then((value) => {
        this.cache.set(key, { at: Date.now(), ttl: value.ok ? RATE_TTL_MS : FAIL_TTL_MS, value });
        if (this.cache.size > 2000) {
          const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 500);
          for (const [k] of oldest) this.cache.delete(k);
        }
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // للمتجر العام: الطرق من غير أي حاجة داخلية
  publicMethods(s: SettingsRow) {
    const { methods } = this.methodsOf(s);
    const on = methods.filter((m) => m.enabled);
    const countries = new Set<string>();
    let anyCountry = false;
    for (const m of on) {
      const list = m.type === "ZONES" ? m.zones.flatMap((z) => z.countries) : m.type === "FLAT" || m.type === "FREE" || m.type === "CARRIER" ? m.countries : [];
      if ((m.type === "ZONES" && m.zones.some((z) => z.countries.length === 0)) || ((m.type === "FLAT" || m.type === "FREE" || m.type === "CARRIER") && m.countries.length === 0)) anyCountry = true;
      list.forEach((c) => countries.add(c));
    }
    const origin = readOrigin(s.shippingOrigin);
    return {
      methods: on.map((m) => ({
        id: m.id,
        type: m.type,
        label: m.label,
        estimate: m.estimate,
        freeOver: m.freeOver,
        ...(m.type === "LOCAL" ? { fee: m.fee, areas: m.areas } : {}),
        ...(m.type === "FLAT" ? { fee: m.fee } : {}),
        ...(m.type === "PICKUP" ? { address: m.address } : {}),
        ...(m.type === "FREE" ? { minOrder: m.minOrder } : {}),
        ...(m.type === "CARRIER" ? { carrier: m.carrier } : {}),
      })),
      needsAddress: needsAddressFields(on),
      // [] + anyCountry = أي دولة
      countries: anyCountry ? [] : [...countries].sort(),
      homeCountry: origin?.country ?? null,
    };
  }

  // ====================== الشحنة (التاجر) ======================
  async createShipment(tenantId: string, orderId: string, input: { carrier?: CarrierCode; service?: string | null; weightKg?: number; lengthCm?: number; widthCm?: number; heightCm?: number; country?: string; city?: string; postalCode?: string | null }) {
    const order = await this.repo.order(tenantId, orderId);
    if (!order) throw new NotFoundError("Order not found");
    if (order.status === "CANCELLED") throw new AppError(409, "ORDER_CANCELLED", "This order was cancelled.");
    if (order.fulfillment === "PICKUP") throw new AppError(400, "PICKUP_ORDER", "This is a pickup order — nothing to ship.");
    const existing = await this.repo.shipment(tenantId, orderId);
    if (existing?.status === "CREATED") throw new AppError(409, "SHIPMENT_EXISTS", "This order already has a shipment.");
    const carrier = (input.carrier ?? order.shippingCarrier) as CarrierCode | null;
    if (!carrier || !(CARRIERS as readonly string[]).includes(carrier)) throw new AppError(400, "CHOOSE_CARRIER", "Choose a shipping company.");
    const s = await this.repo.settings(tenantId);
    const origin = readOrigin(s.shippingOrigin);
    if (!origin) throw new AppError(400, "NO_ORIGIN", "Add your shipping address (where parcels leave from) in Settings → Shipping first.");
    const { client, mode } = await this.client(tenantId, carrier);

    const country = (input.country || order.shippingCountry || origin.country).toUpperCase();
    const city = (input.city || order.shippingCity || order.area || "").trim();
    if (!city) throw new AppError(400, "NEED_CITY", "Write the customer's city.");
    if (!order.address || order.address.trim().length < 3) throw new AppError(400, "NEED_ADDRESS", "This order has no delivery address.");
    const items = (Array.isArray(order.items) ? order.items : []) as { productId: string; name: string; qty: number }[];
    const pkg = readPackage(s.shippingPackage);
    const weights = await this.weights(tenantId, items.map((i) => i.productId));
    const parcel = cartParcel(items, weights, pkg);
    if (input.weightKg) parcel.weightKg = input.weightKg;
    if (input.lengthCm) parcel.lengthCm = input.lengthCm;
    if (input.widthCm) parcel.widthCm = input.widthCm;
    if (input.heightCm) parcel.heightCm = input.heightCm;
    const destination: ShipAddress = {
      name: order.customerName,
      phone: order.customerPhone,
      email: order.customerEmail,
      line1: order.address.trim().slice(0, 200),
      city,
      postalCode: input.postalCode ?? order.shippingPostalCode ?? null,
      country,
    };
    const declaredUsd = Math.max(1, Number(order.subtotal) - Number(order.discount));
    const base = { origin: { ...origin }, destination, parcel, declaredValue: { amount: round6(declaredUsd), currency: "USD" }, shipDate: this.now() };

    let service = input.service || (carrier === order.shippingCarrier ? order.shippingService : null);
    if (!service) {
      // ماحددش خدمة: أرخص خدمة متاحة دلوقتي
      try {
        const rates = await client.quoteRates(base);
        if (!rates.length) throw new AppError(400, "NO_SERVICE", `${CARRIER_NAMES[carrier]} has no service for this address.`);
        service = [...rates].sort((a, b) => a.amount - b.amount)[0].service;
      } catch (e) {
        throw this.toAppError(e, carrier);
      }
    }

    if (!(await this.repo.claimShipment(tenantId, orderId, carrier, service, mode))) throw new AppError(409, "SHIPMENT_IN_PROGRESS", "This shipment is already being created — wait a moment.");
    try {
      const created = await client.createShipment({ ...base, service, description: items.map((i) => i.name).join(", ").slice(0, 100) || "Goods", reference: `#${order.number}`, pieces: items.reduce((n, i) => n + (Number(i.qty) || 0), 0) || 1 });
      await this.repo.shipmentCreated(tenantId, orderId, { trackingNumber: created.trackingNumber, service: created.service, labelPdf: created.labelPdf ?? null, labelUrl: created.labelUrl ?? null });
      await this.repo.markOrderShipped(tenantId, orderId, publicTrackingUrl(carrier, created.trackingNumber));
    } catch (e) {
      const err = this.toAppError(e, carrier);
      await this.repo.shipmentFailed(tenantId, orderId, err.message);
      throw err;
    }
    return this.shipmentView(tenantId, orderId);
  }

  private async weights(tenantId: string, productIds: string[]) {
    const rows = await this.repo.productWeights(tenantId, [...new Set(productIds)]);
    return new Map(rows.map((r) => [r.id, num(r.weightKg)]));
  }

  async shipmentView(tenantId: string, orderId: string) {
    const sh = await this.repo.shipment(tenantId, orderId);
    if (!sh) return null;
    return this.view(sh);
  }

  // للراوت: الطلب لازم يكون بتاع الشركة دي (وإلا 404) - الشحنة ممكن تكون لسه null
  async orderShipment(tenantId: string, orderId: string) {
    if (!(await this.repo.order(tenantId, orderId))) throw new NotFoundError("Order not found");
    return this.shipmentView(tenantId, orderId);
  }

  view(sh: { carrier: string; service: string | null; status: string; trackingNumber: string | null; trackingStatus: string | null; trackingEvents: unknown; lastTrackedAt: Date | null; deliveredAt: Date | null; error: string | null; labelUrl?: string | null; mode: string; createdAt: Date; labelPdf?: Buffer | Uint8Array | null }) {
    const events = (Array.isArray(sh.trackingEvents) ? sh.trackingEvents : []) as TrackingEvent[];
    return {
      carrier: sh.carrier,
      carrierName: CARRIER_NAMES[sh.carrier as CarrierCode] ?? sh.carrier,
      service: sh.service,
      status: sh.status,
      mode: sh.mode,
      trackingNumber: sh.trackingNumber,
      trackingUrl: sh.trackingNumber ? publicTrackingUrl(sh.carrier, sh.trackingNumber) : null,
      trackingStatus: (sh.trackingStatus ?? null) as TrackingStatus | null,
      events,
      lastTrackedAt: sh.lastTrackedAt,
      deliveredAt: sh.deliveredAt,
      error: sh.status === "FAILED" ? sh.error : null,
      hasLabel: sh.status === "CREATED",
      createdAt: sh.createdAt,
    };
  }

  // شحنات أكتر من طلب (لوحة الطلبات)
  async shipmentsFor(tenantId: string, orderIds: string[]) {
    if (!orderIds.length) return new Map<string, ReturnType<ShippingService["view"]>>();
    const rows = await this.repo.shipmentMeta(tenantId, orderIds);
    return new Map(rows.map((r) => [r.orderId, this.view(r)]));
  }

  async label(tenantId: string, orderId: string): Promise<{ pdf: Buffer; fileName: string } | { url: string }> {
    const l = await this.repo.label(tenantId, orderId);
    if (!l) throw new NotFoundError("No shipping label for this order yet");
    if (l.labelPdf && l.labelPdf.length) return { pdf: Buffer.from(l.labelPdf), fileName: `label-${l.carrier.toLowerCase()}-${l.trackingNumber}.pdf` };
    if (l.labelUrl) return { url: l.labelUrl };
    throw new NotFoundError("The carrier didn't send a label — open the shipment in your carrier account.");
  }

  // ====================== التتبع ======================
  async refreshTracking(tenantId: string, orderId: string) {
    const sh = await this.repo.shipment(tenantId, orderId);
    if (!sh || sh.status !== "CREATED" || !sh.trackingNumber) throw new NotFoundError("No shipment to track");
    const carrier = sh.carrier as CarrierCode;
    try {
      const { client } = await this.client(tenantId, carrier);
      const t = await client.track(sh.trackingNumber);
      const delivered = t.status === "DELIVERED";
      await this.repo.saveTracking(tenantId, orderId, {
        trackingStatus: t.status,
        trackingEvents: t.events.slice(0, MAX_EVENTS) as unknown as Prisma.InputJsonValue,
        ...(delivered && !sh.deliveredAt ? { deliveredAt: t.events[0]?.at ? new Date(t.events[0].at) : this.now() } : {}),
      });
      if (delivered) await this.repo.markOrderDelivered(tenantId, orderId);
    } catch (e) {
      const err = this.toAppError(e, carrier);
      await this.repo.trackingFailed(tenantId, orderId, err.message);
      throw err;
    }
    return this.shipmentView(tenantId, orderId);
  }

  // الشغلانة (كل ساعتين): الشحنات اللي لسه ماوصلتش. شركة بتفشل = نكمل في الباقي
  async runTracking(opts: { take?: number; olderThanMs?: number; isOpen?: (tenantIds: string[]) => Promise<Set<string>> } = {}) {
    const due = await this.repo.dueForTracking(new Date(Date.now() - (opts.olderThanMs ?? 90 * 60_000)), opts.take ?? 50);
    const open = opts.isOpen ? await opts.isOpen([...new Set(due.map((d) => d.tenantId))]) : null;
    let updated = 0;
    let delivered = 0;
    let failed = 0;
    for (const d of due) {
      if (open && !open.has(d.tenantId)) continue;
      try {
        const v = await this.refreshTracking(d.tenantId, d.orderId);
        updated++;
        if (v?.trackingStatus === "DELIVERED") delivered++;
      } catch {
        failed++;
      }
    }
    return { checked: due.length, updated, delivered, failed };
  }
}
