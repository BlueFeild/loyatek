import { describe, expect, it } from "vitest";
import { ContactBookService, normalizePhone, normalizeTags, rowsToContacts } from "../modules/whatsapp/contact-book.service";
import type { ContactBookStore, ContactInput, ContactRow, TagMatch } from "../modules/whatsapp/contact-book.repository";
import { optIntent } from "../modules/whatsapp/opt-out";
import { statusesBelow, summarizeCampaign } from "../modules/whatsapp/campaign-report";

// تخزين في الذاكرة بنفس عقد Prisma
class MemoryBook implements ContactBookStore {
  rows: (ContactRow & { tenantId: string })[] = [];
  private n = 0;
  private make(tenantId: string, input: ContactInput, source: string) {
    const row = { id: `c${++this.n}`, tenantId, phone: input.phone, name: input.name ?? null, tags: input.tags ?? [], optedOut: false, optedOutAt: null, source, lastInboundAt: null, createdAt: new Date() };
    this.rows.push(row);
    return row;
  }
  async list(tenantId: string) {
    const items = this.rows.filter((r) => r.tenantId === tenantId);
    return { items, total: items.length };
  }
  async tagCounts() {
    return [];
  }
  async stats(tenantId: string) {
    const mine = this.rows.filter((r) => r.tenantId === tenantId);
    return { total: mine.length, optedOut: mine.filter((r) => r.optedOut).length };
  }
  async findById(tenantId: string, id: string) {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }
  async findByPhone(tenantId: string, phone: string) {
    return this.rows.find((r) => r.tenantId === tenantId && r.phone === phone) ?? null;
  }
  async create(tenantId: string, input: ContactInput, source: string) {
    return this.make(tenantId, input, source);
  }
  async update(tenantId: string, id: string, data: Partial<ContactRow>) {
    const r = await this.findById(tenantId, id);
    if (!r) return null;
    Object.assign(r, data);
    return r;
  }
  async delete(tenantId: string, id: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.tenantId === tenantId && r.id === id));
    return this.rows.length < before;
  }
  async upsertMany(tenantId: string, rows: ContactInput[], source: string) {
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const e = await this.findByPhone(tenantId, r.phone);
      if (!e) {
        this.make(tenantId, r, source);
        created++;
      } else {
        e.tags = [...new Set([...e.tags, ...(r.tags ?? [])])];
        updated++;
      }
    }
    return { created, updated };
  }
  async bulkTags() {
    return 0;
  }
  async setOptOut(tenantId: string, phone: string, optedOut: boolean, at: Date) {
    const e = (await this.findByPhone(tenantId, phone)) ?? this.make(tenantId, { phone }, "inbound");
    e.optedOut = optedOut;
    e.optedOutAt = optedOut ? at : null;
  }
  async touchInbound(tenantId: string, phone: string, name: string | null, at: Date) {
    const e = (await this.findByPhone(tenantId, phone)) ?? this.make(tenantId, { phone, name }, "inbound");
    e.lastInboundAt = at;
  }
  async audience(tenantId: string, tags: string[], match: TagMatch) {
    return this.rows
      .filter((r) => r.tenantId === tenantId && !r.optedOut && (match === "all" ? tags.every((t) => r.tags.includes(t)) : tags.some((t) => r.tags.includes(t))))
      .map((r) => ({ phone: r.phone, name: r.name ?? "" }));
  }
  async countAudience(tenantId: string, tags: string[], match: TagMatch) {
    return (await this.audience(tenantId, tags, match)).length;
  }
  async optedOutAmong() {
    return new Set<string>();
  }
}

function setup() {
  const store = new MemoryBook();
  const customers = [
    { name: "Sara", phone: "+974 5555 0001", sources: ["Booking Customer", "Wallet Member"] },
    { name: "Bad", phone: "12", sources: ["Catalog Customer"] },
  ];
  return { store, service: new ContactBookService(store, { customers: async () => customers }) };
}

describe("contact book helpers", () => {
  it("normalizes phones (00 prefix, symbols) and rejects short ones", () => {
    expect(normalizePhone("+974 5555-1234")).toBe("97455551234");
    expect(normalizePhone("0097455551234")).toBe("97455551234");
    expect(normalizePhone("5551")).toBeNull();
  });
  it("tags: lowercase, unique, comma / Arabic comma separated", () => {
    expect(normalizeTags("VIP, doha،  Doha ,")).toEqual(["vip", "doha"]);
    expect(normalizeTags(["A", "a", "b"])).toEqual(["a", "b"]);
  });
  it("reads Excel rows by column name (Arabic too), merges duplicates, counts invalid", () => {
    const { contacts, invalid } = rowsToContacts(
      [
        { "الاسم": "سارة", "رقم الجوال": "+97455550001", "تصنيف": "vip" },
        { "الاسم": "", "رقم الجوال": "97455550001", "تصنيف": "doha" },
        { "الاسم": "x", "رقم الجوال": "123", "تصنيف": "" },
      ],
      ["ramadan"]
    );
    expect(invalid).toBe(1);
    expect(contacts).toEqual([{ phone: "97455550001", name: "سارة", tags: ["vip", "ramadan", "doha"] }]);
  });
});

describe("opt-out keywords", () => {
  it("only a whole message counts (Arabic + English, any spelling of alef)", () => {
    expect(optIntent("STOP")).toBe("OUT");
    expect(optIntent(" إلغاء ")).toBe("OUT");
    expect(optIntent("ايقاف")).toBe("OUT");
    expect(optIntent("اشتراك")).toBe("IN");
    expect(optIntent("Start")).toBe("IN");
    expect(optIntent("عايز الغاء الحجز")).toBeNull();
    expect(optIntent("please stop calling")).toBeNull();
  });
});

describe("ContactBookService", () => {
  it("inbound STOP opts the number out, START back in; any message lands in the book", async () => {
    const { store, service } = setup();
    expect(await service.handleInbound("t1", "97455550009", "Ali", "hello")).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(await service.handleInbound("t1", "97455550009", "Ali", "stop")).toBe("OUT");
    expect(store.rows[0].optedOut).toBe(true);
    expect(await service.handleInbound("t1", "97455550009", "Ali", "اشتراك")).toBe("IN");
    expect(store.rows[0].optedOut).toBe(false);
  });
  it("create refuses bad / duplicate numbers; other companies never see the contact", async () => {
    const { service } = setup();
    await service.create("t1", { phone: "+974 5555 1234", tags: "VIP" });
    await expect(service.create("t1", { phone: "97455551234" })).rejects.toMatchObject({ status: 400 });
    await expect(service.create("t1", { phone: "55" })).rejects.toMatchObject({ status: 400 });
    expect((await service.list("t2", {})).total).toBe(0);
    await expect(service.update("t2", "c1", { name: "hack" })).rejects.toMatchObject({ status: 404 });
    await expect(service.remove("t2", "c1")).rejects.toMatchObject({ status: 404 });
  });
  it("sync customers tags them by where they came from and skips bad numbers", async () => {
    const { store, service } = setup();
    expect(await service.syncCustomers("t1")).toMatchObject({ created: 1, total: 1 });
    expect(store.rows[0]).toMatchObject({ phone: "97455550001", tags: ["booking", "loyalty"], source: "customers" });
  });
  it("audience count needs at least one tag", async () => {
    const { service } = setup();
    await service.create("t1", { phone: "97455550002", tags: ["vip"] });
    expect(await service.audienceCount("t1", "vip", "any")).toEqual({ count: 1 });
    expect(await service.audienceCount("t1", "", "any")).toEqual({ count: 0 });
  });
});

describe("campaign report", () => {
  it("status only moves forward (read is never overwritten by a late delivered)", () => {
    expect(statusesBelow("read")).toEqual(["sent", "delivered", "received"]);
    expect(statusesBelow("delivered")).toEqual(["sent", "received"]);
    expect(statusesBelow("failed")).toBeNull();
  });
  it("counts sent / delivered / read / failed / replied with rates", () => {
    const t = new Date("2026-11-03T10:00:00Z");
    const msgs = [
      { contactPhone: "1", contactName: "A", status: "read", error: null, createdAt: t },
      { contactPhone: "2", contactName: "B", status: "delivered", error: null, createdAt: t },
      { contactPhone: "3", contactName: "C", status: "sent", error: null, createdAt: t },
      { contactPhone: "4", contactName: "D", status: "failed", error: "bad number", createdAt: t },
    ];
    const replies = new Map([
      ["1", new Date(t.getTime() + 60_000)],
      ["2", new Date(t.getTime() - 60_000)], // قبل الحملة ← مش رد
    ]);
    const r = summarizeCampaign(msgs, replies, 2);
    expect(r).toMatchObject({ total: 4, sent: 3, delivered: 2, read: 1, failed: 1, replied: 1, skipped: 2 });
    expect(r.rates).toEqual({ delivered: 66.7, read: 33.3, replied: 33.3 });
    expect(r.recipients[0]).toMatchObject({ phone: "1", replied: true });
  });
});
