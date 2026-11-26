import { describe, expect, it } from "vitest";
import { cleanPageUrl, HelpDeskService, type HelpMailer, type HelpReplyRow, type HelpStatus, type HelpStore, type HelpTicketRow } from "../modules/help-desk/help-desk.service";

class MemStore implements HelpStore {
  tickets: HelpTicketRow[] = [];
  reps: HelpReplyRow[] = [];
  n = 0;
  async countCreatedSince(tenantId: string, since: Date) {
    return this.tickets.filter((t) => t.tenantId === tenantId && t.createdAt >= since).length;
  }
  async create(d: any) {
    const t: HelpTicketRow = { id: `t${++this.n}`, status: "OPEN", lastActivityAt: new Date(), lastFromSuperAdmin: false, createdAt: d.createdAt ?? new Date(), ...d };
    this.tickets.push(t);
    return t;
  }
  async find(id: string, tenantId: string | null) {
    return this.tickets.find((t) => t.id === id && (!tenantId || t.tenantId === tenantId)) ?? null;
  }
  async listForTenant(tenantId: string) {
    return this.tickets.filter((t) => t.tenantId === tenantId).map((t) => ({ ...t, replyCount: this.reps.filter((r) => r.ticketId === t.id).length }));
  }
  async listAll(status: HelpStatus | null) {
    return this.tickets.filter((t) => !status || t.status === status).map((t) => ({ ...t, replyCount: 0 }));
  }
  async countByStatus() {
    const out = { OPEN: 0, ANSWERED: 0, CLOSED: 0 } as Record<HelpStatus, number>;
    for (const t of this.tickets) out[t.status as HelpStatus]++;
    return out;
  }
  async replies(ticketId: string) {
    return this.reps.filter((r) => r.ticketId === ticketId);
  }
  async addReply(ticketId: string, d: any) {
    const r: HelpReplyRow = { id: `r${++this.n}`, ticketId, fromSuperAdmin: d.fromSuperAdmin, authorUserId: d.authorUserId, message: d.message, createdAt: new Date() };
    this.reps.push(r);
    const t = this.tickets.find((x) => x.id === ticketId)!;
    t.status = d.status;
    t.lastFromSuperAdmin = d.fromSuperAdmin;
    return r;
  }
  async setStatus(ticketId: string, status: HelpStatus) {
    this.tickets.find((x) => x.id === ticketId)!.status = status;
  }
  async people(ids: string[]) {
    return ids.map((id) => ({ id, name: `Name ${id}`, email: `${id}@x.test` }));
  }
  async companies(ids: string[]) {
    return ids.map((id) => ({ id, name: `Co ${id}`, slug: id }));
  }
}

class MemMailer implements HelpMailer {
  support: { subject: string; text: string; replyTo?: string }[] = [];
  merchant: { email: string; subject: string }[] = [];
  notes: { tenantId: string; link: string }[] = [];
  async toSupport(subject: string, text: string, replyTo?: string) {
    this.support.push({ subject, text, replyTo });
  }
  async toMerchant(email: string, subject: string) {
    this.merchant.push({ email, subject });
  }
  async notifyTenant(tenantId: string, _t: string, _b: string, link: string) {
    this.notes.push({ tenantId, link });
  }
}

const links = { adminTicket: (id: string) => `https://x/super-admin?ticket=${id}`, merchantTicket: (id: string) => `https://x/dashboard?help=${id}` };
const A = { tenantId: "A", userId: "ua" };
const B = { tenantId: "B", userId: "ub" };
const setup = (max = 10) => {
  const store = new MemStore();
  const mailer = new MemMailer();
  return { store, mailer, svc: new HelpDeskService(store, mailer, links, { maxTicketsPerHour: max }) };
};
const body = { category: "problem", subject: "  Menu not saving ", message: "It fails", pageUrl: "/catalog?tab=menu" };

describe("help desk", () => {
  it("creates a ticket, trims text and emails support with reply-to = merchant", async () => {
    const { svc, mailer } = setup();
    const t = await svc.create(A, body);
    expect(t.subject).toBe("Menu not saving");
    expect(t.status).toBe("OPEN");
    expect(mailer.support).toHaveLength(1);
    expect(mailer.support[0].replyTo).toBe("ua@x.test");
    expect(mailer.support[0].text).toContain("Co A");
    expect(mailer.support[0].text).toContain("https://x/super-admin?ticket=");
  });

  it("refuses bad input", async () => {
    const { svc } = setup();
    await expect(svc.create(A, { ...body, category: "other" })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(A, { ...body, subject: "x".repeat(121) })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(A, { ...body, message: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(A, { ...body, tenantId: "B" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps companies apart", async () => {
    const { svc } = setup();
    const t = await svc.create(A, body);
    await expect(svc.getMine(B, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.replyAsMerchant(B, t.id, { message: "hi" })).rejects.toMatchObject({ status: 404 });
    expect(await svc.listMine(B)).toHaveLength(0);
    expect(await svc.listMine(A)).toHaveLength(1);
  });

  it("limits new tickets per company per hour", async () => {
    const { svc } = setup(2);
    await svc.create(A, body);
    await svc.create(A, body);
    await expect(svc.create(A, body)).rejects.toMatchObject({ status: 429 });
    await expect(svc.create(B, body)).resolves.toBeTruthy(); // another company is not affected
  });

  it("status: admin reply = ANSWERED (+ email + notification), merchant reply = OPEN again, admin can close", async () => {
    const { svc, mailer } = setup();
    const t = await svc.create(A, body);
    const afterAdmin = await svc.replyAsAdmin("admin1", t.id, { message: "Fixed, try again" });
    expect(afterAdmin.status).toBe("ANSWERED");
    expect(mailer.merchant[0]).toMatchObject({ email: "ua@x.test", subject: "Re: Menu not saving" });
    expect(mailer.notes[0]).toMatchObject({ tenantId: "A", link: `/dashboard?help=${t.id}` });

    const mine = await svc.getMine(A, t.id);
    expect(mine.replies[0]).toMatchObject({ fromSuperAdmin: true, author: "BlueField team" }); // no staff name for merchants
    expect((await svc.listMine(A))[0].lastFromSuperAdmin).toBe(true);

    await svc.adminSetStatus(t.id, { status: "CLOSED" });
    const reopened = await svc.replyAsMerchant(A, t.id, { message: "Still broken" });
    expect(reopened.status).toBe("OPEN");
    expect(mailer.support).toHaveLength(2);
    await expect(svc.adminSetStatus(t.id, { status: "DONE" })).rejects.toMatchObject({ status: 400 });
  });

  it("admin list filters by status and counts", async () => {
    const { svc } = setup();
    const t1 = await svc.create(A, body);
    await svc.create(B, body);
    await svc.replyAsAdmin("admin1", t1.id, { message: "ok" });
    const open = await svc.adminList("OPEN");
    expect(open.tickets.map((t) => t.company.name)).toEqual(["Co B"]);
    expect(open.counts).toEqual({ OPEN: 1, ANSWERED: 1, CLOSED: 0 });
    expect((await svc.adminList("nonsense")).tickets).toHaveLength(2);
  });

  it("page url keeps only a safe path", () => {
    expect(cleanPageUrl("https://digital.blue-field.co/booking?tab=today")).toBe("/booking?tab=today");
    expect(cleanPageUrl("/reset-password?token=abc")).toBe("/reset-password?token=…");
    expect(cleanPageUrl("javascript:alert(1)")).toBeNull();
    expect(cleanPageUrl("//evil.com/x")).toBeNull();
  });
});
