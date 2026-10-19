import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));
import { invoiceBalance, invoiceView } from "../modules/accounting/invoice-payments";

describe("invoice balance", () => {
  it("unpaid / partial / paid from the payments", () => {
    expect(invoiceBalance({ status: "ISSUED", total: "105", payments: [] })).toEqual({ paidAmount: 0, balanceDue: 105, paymentStatus: "UNPAID" });
    expect(invoiceBalance({ status: "ISSUED", total: "105", payments: [{ amount: "40" }] })).toEqual({ paidAmount: 40, balanceDue: 65, paymentStatus: "PARTIAL" });
    expect(invoiceBalance({ status: "PAID", total: "105", payments: [{ amount: "40" }, { amount: "65" }] }).paymentStatus).toBe("PAID");
  });
  it("currency rounding leftovers count as paid", () => {
    const b = invoiceBalance({ status: "ISSUED", total: "100", payments: [{ amount: "99.999" }] });
    expect(b.paymentStatus).toBe("PAID");
    expect(b.balanceDue).toBe(0);
  });
  it("an old PAID invoice with no recorded payments is fully paid", () => {
    expect(invoiceBalance({ status: "PAID", total: "50", payments: [] })).toEqual({ paidAmount: 50, balanceDue: 0, paymentStatus: "PAID" });
  });
  it("drafts are not receivables", () => {
    expect(invoiceBalance({ status: "DRAFT", total: "50" }).paymentStatus).toBe("DRAFT");
  });
  it("overdue = something left and the due date has passed", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    expect(invoiceView({ status: "ISSUED", total: "50", payments: [], dueDate: new Date("2026-10-10") }, now).overdue).toBe(true);
    expect(invoiceView({ status: "ISSUED", total: "50", payments: [{ amount: "50" }], dueDate: new Date("2026-10-10") }, now).overdue).toBe(false);
    expect(invoiceView({ status: "ISSUED", total: "50", payments: [], dueDate: new Date("2026-10-30") }, now).overdue).toBe(false);
    expect(invoiceView({ status: "ISSUED", total: "50", payments: [] }, now).overdue).toBe(false);
  });
});
