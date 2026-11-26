import { prisma } from "../../../config/db";
import { getRates, isCurrencyCode, rateFor } from "../../../utils/money";
import { decryptToken, encryptToken } from "../../social/token-crypto";
import { makeCarrierFactory } from "./carrier.factory";
import { ShippingRepository } from "./shipping.repository";
import { ShippingService } from "./shipping.service";

// توصيل خدمة الشحن (نفس فكرة core/container.ts - هنا عشان store.routes ↔ container مايلفّوش على بعض):
// الشركات الحقيقية + المفاتيح متشفّرة بـ token-crypto + أسعار الصرف من utils/money
export const shippingService = new ShippingService(
  new ShippingRepository(prisma),
  makeCarrierFactory(),
  { seal: encryptToken, open: decryptToken },
  { supported: (c) => isCurrencyCode(c), rateFor: async (c) => rateFor(c, await getRates()) }
);
