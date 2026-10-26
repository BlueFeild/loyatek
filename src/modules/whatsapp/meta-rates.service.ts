import { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_META_RATES, MetaCostEstimator, META_RATES_NOTE, mergeRates, type MetaRateTable } from "./meta-rates";

export interface MetaRatesStore {
  load(): Promise<unknown>;
  save(overrides: MetaRateTable): Promise<void>;
}

export class PrismaMetaRatesStore implements MetaRatesStore {
  constructor(private readonly db: PrismaClient) {}

  async load() {
    const row = await this.db.platformSettings.findUnique({ where: { id: "singleton" }, select: { whatsappMetaRates: true } });
    return row?.whatsappMetaRates ?? {};
  }

  async save(overrides: MetaRateTable) {
    const value = overrides as unknown as Prisma.InputJsonValue;
    await this.db.platformSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", whatsappMetaRates: value }, update: { whatsappMetaRates: value } });
  }
}

// أسعار Meta الحالية (الافتراضي + تعديلات السوبر أدمن) مع كاش 60 ثانية
export class MetaRatesService {
  private cache: { at: number; rates: MetaRateTable } | null = null;

  constructor(private readonly store: MetaRatesStore, private readonly ttlMs = 60_000) {}

  async rates(): Promise<MetaRateTable> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.rates;
    const rates = mergeRates(await this.store.load());
    this.cache = { at: Date.now(), rates };
    return rates;
  }

  async estimator(): Promise<MetaCostEstimator> {
    return new MetaCostEstimator(await this.rates());
  }

  async publicView() {
    return { currency: "USD", rates: await this.rates(), defaults: DEFAULT_META_RATES, note: META_RATES_NOTE };
  }

  // السوبر أدمن بيبعت الجدول كله (الدول اللي اتشالت بترجع للافتراضي)
  async replace(overrides: MetaRateTable) {
    await this.store.save(overrides);
    this.cache = null;
    return this.publicView();
  }
}
