import { describe, expect, it } from "vitest";
import {
  canChangeStatus,
  deliveryFeeFor,
  matchOptions,
  optionsSchema,
  priceCart,
  productInput,
  productPatch,
  readOptions,
  settingsInput,
  stockToReturn,
  type DeliveryConfig,
  type ProductForPricing,
} from "../modules/store/store.logic";

const cfg: DeliveryConfig = { deliveryEnabled: true, deliveryFee: 5, freeDeliveryOver: 100, areas: [], pickupEnabled: true };
const perfume: ProductForPricing = { id: "11111111-1111-4111-8111-111111111111", name: "Oud Night", price: 40, stock: 3, active: true, options: [{ name: "Size", values: ["50ml", "100ml"] }], coverPhotoId: "p1" };
const tee: ProductForPricing = { id: "22222222-2222-4222-8222-222222222222", name: "Tee", price: 12.5, stock: null, active: true, options: [], coverPhotoId: null };

describe("store options", () => {
  it("needs every option chosen, from the list, nothing extra", () => {
    expect(matchOptions("Oud", perfume.options, { Size: "50ml" })).toEqual({ Size: "50ml" });
    expect(() => matchOptions("Oud", perfume.options, {})).toThrow(/choose Size/);
    expect(() => matchOptions("Oud", perfume.options, { Size: "1L" })).toThrow(/isn't available/);
    expect(() => matchOptions("Oud", perfume.options, { Size: "50ml", Color: "Red" })).toThrow(/isn't an option/);
    expect(matchOptions("Tee", [], undefined)).toEqual({});
  });
  it("limits options and removes duplicate values", () => {
    expect(optionsSchema.parse([{ name: "Color", values: ["Red", "Red", "Blue"] }])).toEqual([{ name: "Color", values: ["Red", "Blue"] }]);
    expect(optionsSchema.safeParse([{ name: "A", values: ["x"] }, { name: "a", values: ["y"] }]).success).toBe(false);
    expect(optionsSchema.safeParse(Array.from({ length: 4 }, (_, i) => ({ name: `O${i}`, values: ["x"] }))).success).toBe(false);
    expect(optionsSchema.safeParse([{ name: "Size", values: Array.from({ length: 21 }, (_, i) => `v${i}`) }]).success).toBe(false);
    expect(readOptions("junk")).toEqual([]);
  });
});

describe("store delivery", () => {
  it("flat fee, free over an amount, pickup", () => {
    expect(deliveryFeeFor(cfg, "DELIVERY", null, 50).fee).toBe(5);
    expect(deliveryFeeFor(cfg, "DELIVERY", null, 100).fee).toBe(0);
    expect(deliveryFeeFor(cfg, "PICKUP", null, 10).fee).toBe(0);
    expect(() => deliveryFeeFor({ ...cfg, pickupEnabled: false }, "PICKUP", null, 10)).toThrow(/pickup/);
    expect(() => deliveryFeeFor({ ...cfg, deliveryEnabled: false }, "DELIVERY", null, 10)).toThrow(/deliver/);
  });
  it("area fees need a known area", () => {
    const withAreas = { ...cfg, areas: [{ name: "Doha", fee: 3 }, { name: "Al Wakrah", fee: 8 }] };
    expect(deliveryFeeFor(withAreas, "DELIVERY", "al wakrah", 20)).toEqual({ fee: 8, area: "Al Wakrah" });
    expect(() => deliveryFeeFor(withAreas, "DELIVERY", "Mars", 20)).toThrow(/area/);
    expect(() => deliveryFeeFor(withAreas, "DELIVERY", null, 20)).toThrow(/area/);
  });
});

describe("store cart pricing", () => {
  it("uses server prices and merges same lines", () => {
    const r = priceCart(
      [
        { productId: perfume.id, qty: 1, options: { Size: "50ml" } },
        { productId: perfume.id, qty: 1, options: { Size: "50ml" } },
        { productId: tee.id, qty: 2 },
      ],
      [perfume, tee],
      cfg,
      "DELIVERY"
    );
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].qty).toBe(2);
    expect(r.subtotal).toBe(105);
    expect(r.deliveryFee).toBe(0);
    expect(r.total).toBe(105);
    expect(r.need.get(perfume.id)).toBe(2);
  });
  it("refuses more than the stock across lines", () => {
    expect(() =>
      priceCart(
        [
          { productId: perfume.id, qty: 2, options: { Size: "50ml" } },
          { productId: perfume.id, qty: 2, options: { Size: "100ml" } },
        ],
        [perfume],
        cfg,
        "PICKUP"
      )
    ).toThrow(/Only 3 left/);
    expect(() => priceCart([{ productId: perfume.id, qty: 1, options: { Size: "50ml" } }], [{ ...perfume, stock: 0 }], cfg, "PICKUP")).toThrow(/sold out/);
  });
  it("refuses hidden / unknown products and empty carts", () => {
    expect(() => priceCart([{ productId: tee.id, qty: 1 }], [{ ...tee, active: false }], cfg, "PICKUP")).toThrow(/no longer available/);
    expect(() => priceCart([{ productId: "x", qty: 1 }], [tee], cfg, "PICKUP")).toThrow(/no longer available/);
    expect(() => priceCart([], [tee], cfg, "PICKUP")).toThrow(/empty/);
    expect(() => priceCart([{ productId: tee.id, qty: 0 }], [tee], cfg, "PICKUP")).toThrow(/Quantity/);
  });
});

describe("store inputs + orders", () => {
  it("old price must be higher than the price", () => {
    expect(productInput.safeParse({ name: "A", price: 10, comparePrice: 12 }).success).toBe(true);
    expect(productInput.safeParse({ name: "A", price: 10, comparePrice: 10 }).success).toBe(false);
    expect(productPatch.safeParse({ comparePrice: null }).success).toBe(true);
    expect(productInput.safeParse({ name: "A", price: -1 }).success).toBe(false);
  });
  it("settings refuse SVG logos and unknown fields", () => {
    expect(settingsInput.safeParse({ logoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(settingsInput.safeParse({ hacker: 1 }).success).toBe(false);
    expect(settingsInput.safeParse({ deliveryAreas: [{ name: "Doha", fee: 2 }, { name: "doha", fee: 3 }] }).success).toBe(false);
    expect(settingsInput.parse({ email: "" }).email).toBeNull();
  });
  it("stock to give back on cancel + status rules", () => {
    const back = stockToReturn([{ productId: "a", qty: 2 }, { productId: "a", qty: 1 }, { productId: "b", qty: 1 }, { bad: true }]);
    expect(back.get("a")).toBe(3);
    expect(back.get("b")).toBe(1);
    expect(canChangeStatus("NEW", "SHIPPED")).toBe(true);
    expect(canChangeStatus("CANCELLED", "NEW")).toBe(false);
  });
});
