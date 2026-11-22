import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
vi.mock("../core/container", () => ({ container: {} }));
import { inactiveCustomers } from "../modules/whatsapp/offers";

describe("inactiveCustomers", () => {
  const cutoff = new Date("2026-09-23T00:00:00Z");
  it("keeps only people whose LAST visit (booking or order) is before the cutoff, phones normalized, names kept", () => {
    const out = inactiveCustomers(
      [
        { phone: "+974 5550 1111", name: "Old Sara", at: new Date("2026-06-01") },
        { phone: "0097455501111", name: null, at: new Date("2026-07-01") }, // same person, still old
        { phone: "97455502222", name: "Came back", at: new Date("2026-05-01") },
        { phone: "+97455502222", name: "Came back", at: new Date("2026-11-01") }, // recent visit → not inactive
        { phone: "123", name: "bad", at: new Date("2026-01-01") },
        { phone: "97455503333", name: "", at: new Date("2026-01-01") },
      ],
      cutoff
    );
    expect(out).toEqual([
      { phone: "97455501111", name: "Old Sara" },
      { phone: "97455503333", name: "Customer" },
    ]);
  });
});
