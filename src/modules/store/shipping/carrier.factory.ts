import { z } from "zod";
import { AramexCarrier } from "./aramex.gateway";
import { defaultFetch } from "./carrier-http";
import { DhlCarrier } from "./dhl.gateway";
import { FedexCarrier } from "./fedex.gateway";
import type { AramexCredentials, CarrierCode, CarrierMode, DhlCredentials, FedexCredentials, FetchLike, ShippingCarrier } from "./shipping.types";

// المكان الوحيد اللي بيختار "أي gateway لأي شركة" + أشكال المفاتيح (zod).
// ARAMEX_BASE_URL / FEDEX_BASE_URL / DHL_BASE_URL = سيرفر وهمي للاختبار المحلي بس (مايتحطش على Railway).
const str = (max: number, label: string) => z.string().trim().min(1, `Enter the ${label}`).max(max);
export const credentialSchemas = {
  ARAMEX: z
    .object({
      username: str(200, "username (email)"),
      password: str(200, "password"),
      accountNumber: str(40, "account number"),
      accountPin: str(40, "account PIN"),
      accountEntity: str(10, "account entity (e.g. DOH)"),
      accountCountryCode: z.string().trim().regex(/^[A-Za-z]{2}$/, "Account country = 2 letters (e.g. QA)").transform((v) => v.toUpperCase()),
    })
    .strict(),
  FEDEX: z.object({ apiKey: str(200, "API key"), secretKey: str(200, "secret key"), accountNumber: str(40, "account number") }).strict(),
  DHL: z.object({ apiKey: str(200, "API key"), apiSecret: str(200, "API secret"), accountNumber: str(40, "account number") }).strict(),
} as const;

export type CarrierFactory = (code: CarrierCode, creds: unknown, mode: CarrierMode) => ShippingCarrier;

export function makeCarrierFactory(fetchImpl: FetchLike = defaultFetch, env: NodeJS.ProcessEnv = process.env): CarrierFactory {
  return (code, creds, mode) => {
    if (code === "ARAMEX") return new AramexCarrier(creds as AramexCredentials, mode, fetchImpl, env.ARAMEX_BASE_URL?.trim() || null);
    if (code === "FEDEX") return new FedexCarrier(creds as FedexCredentials, mode, fetchImpl, env.FEDEX_BASE_URL?.trim() || null);
    return new DhlCarrier(creds as DhlCredentials, mode, fetchImpl, env.DHL_BASE_URL?.trim() || null);
  };
}

// آخر 4 من رقم الحساب للعرض ("••1234")
export const accountHint = (accountNumber: string) => accountNumber.replace(/\s/g, "").slice(-4);
