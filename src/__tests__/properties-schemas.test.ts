import { describe, expect, it } from "vitest";
import {
  createListingSchema,
  decodeImageDataUrl,
  featuresSchema,
  isSamePhotoSet,
  normalizeListing,
  photoSchema,
  publicInquirySchema,
  settingsSchema,
  sortListings,
  toSummary,
  updateListingSchema,
  type ListingInput,
} from "../modules/properties/properties.schemas";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("property listing validation", () => {
  it("accepts a full listing", () => {
    const r = createListingSchema.safeParse({
      title: "  Sea view apartment ",
      purpose: "RENT",
      propertyType: "APARTMENT",
      status: "AVAILABLE",
      price: 2500,
      rentPeriod: "MONTH",
      areaSqm: 140,
      bedrooms: 2,
      bathrooms: 2,
      parking: 1,
      furnished: "SEMI",
      location: "The Pearl, Doha",
      mapUrl: "https://maps.app.goo.gl/abc",
      description: "Lovely",
      features: ["Pool", "Gym"],
      featured: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("Sea view apartment");
  });

  it("refuses bad enums, negative numbers, unknown fields and a missing title", () => {
    expect(createListingSchema.safeParse({ title: "x", purpose: "LEASE" }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", propertyType: "CASTLE" }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", status: "GONE" }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", bedrooms: -1 }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", bedrooms: 1.5 }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", price: -5 }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x", tenantId: "other" }).success).toBe(false);
    expect(createListingSchema.safeParse({ purpose: "SALE" }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("only allows http(s) map links", () => {
    expect(updateListingSchema.safeParse({ mapUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(updateListingSchema.safeParse({ mapUrl: "data:text/html,hi" }).success).toBe(false);
    const ok = updateListingSchema.safeParse({ mapUrl: "http://maps.google.com/?q=1" });
    expect(ok.success).toBe(true);
    const empty = updateListingSchema.safeParse({ mapUrl: "" });
    expect(empty.success && empty.data.mapUrl).toBe(null);
  });

  it("cleans features: trims, drops empties and duplicates, max 20", () => {
    const r = featuresSchema.parse([" Pool ", "pool", "", "Sea  view"]);
    expect(r).toEqual(["Pool", "Sea view"]);
    expect(featuresSchema.safeParse(Array.from({ length: 21 }, (_, i) => `f${i}`)).success).toBe(false);
    expect(featuresSchema.safeParse(["x".repeat(41)]).success).toBe(false);
  });

  it("sets the rent period only for rentals", () => {
    expect(normalizeListing({ purpose: "SALE", rentPeriod: "MONTH" }).rentPeriod).toBe(null);
    expect(normalizeListing<ListingInput>({ purpose: "RENT" }).rentPeriod).toBe("MONTH");
    expect(normalizeListing({ purpose: "RENT", rentPeriod: "YEAR" }).rentPeriod).toBe("YEAR");
    // تعديل السعر بس على عقار إيجار: مايلمسش الفترة
    expect(normalizeListing<ListingInput>({ price: 10 }, "RENT").rentPeriod).toBe(undefined);
    expect(normalizeListing({ rentPeriod: "YEAR" }, "SALE").rentPeriod).toBe(null);
  });
});

describe("photos and settings", () => {
  it("accepts PNG/JPEG/WebP data URLs only", () => {
    expect(photoSchema.safeParse({ dataUrl: PNG }).success).toBe(true);
    expect(photoSchema.safeParse({ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(photoSchema.safeParse({ dataUrl: "data:image/png;base64," + "A".repeat(2_200_000) }).success).toBe(false);
  });

  it("decodes data URLs to bytes", () => {
    const img = decodeImageDataUrl(PNG);
    expect(img?.mime).toBe("image/png");
    expect(img?.bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(decodeImageDataUrl("data:text/html;base64,PGI+")).toBe(null);
    expect(decodeImageDataUrl(null)).toBe(null);
  });

  it("validates page settings", () => {
    const r = settingsSchema.safeParse({ accentColor: "#0f766e", whatsapp: "+974 5555 1234", email: "", showPrices: false, logoDataUrl: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.whatsapp).toBe("97455551234");
      expect(r.data.email).toBe(null);
    }
    expect(settingsSchema.safeParse({ accentColor: "red" }).success).toBe(false);
    expect(settingsSchema.safeParse({ whatsapp: "123" }).success).toBe(false);
    expect(settingsSchema.safeParse({ email: "nope" }).success).toBe(false);
  });

  it("checks the photo order is exactly the same photos", () => {
    expect(isSamePhotoSet(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
    expect(isSamePhotoSet(["a", "b"], ["a", "a"])).toBe(false);
    expect(isSamePhotoSet(["a", "b"], ["a", "b", "x"])).toBe(false);
    expect(isSamePhotoSet(["a", "b"], ["a", "x"])).toBe(false);
  });
});

describe("public enquiry", () => {
  it("cleans the phone and requires a name", () => {
    const r = publicInquirySchema.safeParse({ name: "Sara", phone: "+974 5555-1234", email: "", message: "  " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBe("+97455551234");
      expect(r.data.email).toBe(null);
      expect(r.data.message).toBe(null);
    }
    expect(publicInquirySchema.safeParse({ name: "S", phone: "+97455551234" }).success).toBe(false);
    expect(publicInquirySchema.safeParse({ name: "Sara", phone: "12" }).success).toBe(false);
    expect(publicInquirySchema.safeParse({ name: "Sara", phone: "+97455551234", listingId: "not-a-uuid" }).success).toBe(false);
  });
});

describe("summary mapping", () => {
  const row = {
    id: "1",
    title: "Villa",
    purpose: "SALE",
    propertyType: "VILLA",
    status: "AVAILABLE",
    price: { toString: () => "1250000.500000" },
    rentPeriod: "MONTH",
    areaSqm: 400,
    bedrooms: 5,
    bathrooms: 6,
    parking: 2,
    furnished: null,
    location: "Doha",
    featured: false,
    sortOrder: 0,
    views: 3,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    photos: [{ id: "p1" }, { id: "p2" }],
  };

  it("gives cover photo, count and price as a number; no rent period for sale", () => {
    const s = toSummary(row);
    expect(s.price).toBe(1250000.5);
    expect(s.coverPhotoId).toBe("p1");
    expect(s.photoCount).toBe(2);
    expect(s.rentPeriod).toBe(null);
    expect("description" in s).toBe(false);
  });

  it("hides the price when prices are off and handles no photos", () => {
    const s = toSummary({ ...row, photos: [], price: null }, { hidePrice: true });
    expect(s.price).toBe(null);
    expect(s.coverPhotoId).toBe(null);
    expect(toSummary(row, { hidePrice: true }).price).toBe(null);
  });

  it("sorts featured first, then order, then newest", () => {
    const a = { id: "a", featured: false, sortOrder: 0, createdAt: new Date(1) };
    const b = { id: "b", featured: true, sortOrder: 5, createdAt: new Date(1) };
    const c = { id: "c", featured: false, sortOrder: 0, createdAt: new Date(5) };
    expect(sortListings([a, b, c]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});
