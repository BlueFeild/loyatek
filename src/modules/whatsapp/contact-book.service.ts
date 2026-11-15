import { NotFoundError, ValidationError } from "../../core/errors";
import type { ContactBookStore, ContactInput, ContactQuery, ContactRow, ContactUpdate, TagMatch } from "./contact-book.repository";
import { optIntent, type OptIntent } from "./opt-out";

export const CONTACT_LIMITS = { maxTags: 20, maxTagLength: 30, maxImportRows: 20_000, pageSize: 50, maxAttributes: 20, maxAttrKey: 40, maxAttrValue: 200, maxNotes: 2000, maxExport: 20_000 };

// بيانات إضافية: {مفتاح: قيمة} نص بس، والقيم الفاضية بتتشال
export function normalizeAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim().replace(/\s+/g, " ").slice(0, CONTACT_LIMITS.maxAttrKey);
    const value = v == null ? "" : String(v).trim().slice(0, CONTACT_LIMITS.maxAttrValue);
    if (!key || !value || key in out) continue;
    out[key] = value;
    if (Object.keys(out).length >= CONTACT_LIMITS.maxAttributes) break;
  }
  return out;
}

// خانة CSV: بين علامتين، واللي بيبدأ بـ = + - @ بيتحوّل لنص (عشان الإكسل مايشغّلوش كمعادلة) - إلا الأرقام زي +974...
export function csvCell(v: unknown) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?\d[\d\s]*$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// رقم واتساب = أرقام بس مع كود الدولة (00974... ← 974...). أقل من 8 أرقام مش رقم حقيقي
export function normalizePhone(raw: unknown): string | null {
  let digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// التاجز: حروف صغيرة، من غير مسافات زيادة، من غير تكرار
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,،;|]/);
  const out = new Set<string>();
  for (const t of list) {
    const tag = String(t ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, CONTACT_LIMITS.maxTagLength);
    if (tag) out.add(tag);
  }
  return [...out].slice(0, CONTACT_LIMITS.maxTags);
}

// صفوف ملف الإكسل/CSV: بندوّر على عمود الرقم والاسم والتاجز بالاسم (عربي أو إنجليزي)
export function rowsToContacts(rows: Record<string, unknown>[], extraTags: string[] = []): { contacts: ContactInput[]; invalid: number } {
  if (rows.length === 0) return { contacts: [], invalid: 0 };
  const keys = Object.keys(rows[0]);
  const phoneKey = keys.find((k) => /phone|mobile|whatsapp|رقم|جوال|موبايل|number/i.test(k)) ?? keys[0];
  const nameKey = keys.find((k) => k !== phoneKey && /name|اسم/i.test(k)) ?? keys.find((k) => k !== phoneKey);
  const tagsKey = keys.find((k) => /tag|label|segment|تاج|تصنيف|فئة/i.test(k));
  // أي عمود تاني = بيانات إضافية للعميل (المدينة، المرحلة...)
  const extraKeys = keys.filter((k) => k !== phoneKey && k !== nameKey && k !== tagsKey && !/^__empty/i.test(k)).slice(0, CONTACT_LIMITS.maxAttributes);
  const byPhone = new Map<string, ContactInput>();
  let invalid = 0;
  for (const r of rows.slice(0, CONTACT_LIMITS.maxImportRows)) {
    const phone = normalizePhone(r[phoneKey]);
    if (!phone) {
      invalid++;
      continue;
    }
    const name = nameKey ? String(r[nameKey] ?? "").trim().slice(0, 120) || null : null;
    const tags = normalizeTags([...normalizeTags(tagsKey ? r[tagsKey] : ""), ...extraTags]);
    const prev = byPhone.get(phone);
    const attributes = { ...(prev?.attributes ?? {}), ...normalizeAttributes(Object.fromEntries(extraKeys.map((k) => [k, r[k]]))) };
    byPhone.set(phone, { phone, name: prev?.name || name, tags: normalizeTags([...(prev?.tags ?? []), ...tags]), ...(Object.keys(attributes).length ? { attributes } : {}) });
  }
  return { contacts: [...byPhone.values()], invalid };
}

export interface CustomerSource {
  // عملاء حقيقيين من الحجز / المنيو / الولاء (اسم، رقم، مصدر)
  customers(tenantId: string): Promise<{ name: string; phone: string; sources: string[] }[]>;
}

const SOURCE_TAG: Record<string, string> = { "Wallet Member": "loyalty", "Booking Customer": "booking", "Catalog Customer": "orders", "WhatsApp Chat": "whatsapp" };

export class ContactBookService {
  constructor(
    private readonly store: ContactBookStore,
    private readonly customers: CustomerSource
  ) {}

  async list(tenantId: string, query: Partial<ContactQuery> & { page?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const take = CONTACT_LIMITS.pageSize;
    const [result, tags, stats, attributeKeys] = await Promise.all([
      this.store.list(tenantId, { q: query.q?.trim() || undefined, tag: query.tag ? normalizeTags([query.tag])[0] : undefined, status: query.status ?? "all", skip: (page - 1) * take, take }),
      this.store.tagCounts(tenantId),
      this.store.stats(tenantId),
      this.store.attributeKeys(tenantId),
    ]);
    return { ...result, page, pageSize: take, tags, stats, attributeKeys };
  }

  async create(tenantId: string, input: { phone: string; name?: string | null; tags?: unknown }) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ValidationError("Enter the full WhatsApp number with the country code (e.g. +974 5555 1234).");
    if (await this.store.findByPhone(tenantId, phone)) throw new ValidationError("This number is already in your contacts.");
    return this.store.create(tenantId, { phone, name: input.name?.trim() || null, tags: normalizeTags(input.tags ?? []) }, "manual");
  }

  async update(tenantId: string, id: string, input: { name?: string | null; tags?: unknown; optedOut?: boolean; attributes?: unknown; notes?: string | null }) {
    const data: ContactUpdate = {};
    if (input.attributes !== undefined) data.attributes = normalizeAttributes(input.attributes);
    if (input.notes !== undefined) data.notes = input.notes?.trim().slice(0, CONTACT_LIMITS.maxNotes) || null;
    if (input.name !== undefined) data.name = input.name?.trim() || null;
    if (input.tags !== undefined) data.tags = normalizeTags(input.tags);
    if (input.optedOut !== undefined) {
      data.optedOut = input.optedOut;
      data.optedOutAt = input.optedOut ? new Date() : null;
    }
    const row = await this.store.update(tenantId, id, data);
    if (!row) throw new NotFoundError("Contact not found");
    return row;
  }

  // ملف CSV (يفتح في الإكسل بالعربي) بنفس الفلتر اللي في الشاشة
  async exportCsv(tenantId: string, query: Partial<Omit<ContactQuery, "skip" | "take">>) {
    const rows = await this.store.exportRows(
      tenantId,
      { q: query.q?.trim() || undefined, tag: query.tag ? normalizeTags([query.tag])[0] : undefined, status: query.status ?? "all" },
      CONTACT_LIMITS.maxExport
    );
    return contactsCsv(rows);
  }

  async remove(tenantId: string, id: string) {
    if (!(await this.store.delete(tenantId, id))) throw new NotFoundError("Contact not found");
    return { ok: true };
  }

  async importRows(tenantId: string, rows: Record<string, unknown>[], tags: unknown) {
    const { contacts, invalid } = rowsToContacts(rows, normalizeTags(tags ?? []));
    if (contacts.length === 0) throw new ValidationError("No valid phone numbers found — the file needs a Phone column with full numbers (country code included).");
    const r = await this.store.upsertMany(tenantId, contacts, "import");
    return { ...r, invalid, total: contacts.length };
  }

  // عملاء الحجز / المنيو / الولاء + أي حد في محادثات واتساب ← الدفتر، وكل واحد ياخد تاج بمصدره (booking / orders / loyalty / whatsapp)
  async syncCustomers(tenantId: string) {
    const list = await this.customers.customers(tenantId);
    const contacts: ContactInput[] = [];
    for (const c of list) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;
      contacts.push({ phone, name: c.name?.trim() || null, tags: normalizeTags(c.sources.map((s) => SOURCE_TAG[s] ?? s)) });
    }
    const r = await this.store.upsertMany(tenantId, contacts, "customers");
    return { ...r, total: contacts.length };
  }

  async bulkTags(tenantId: string, ids: string[], add: unknown, remove: unknown) {
    const n = await this.store.bulkTags(tenantId, ids, normalizeTags(add ?? []), normalizeTags(remove ?? []));
    return { updated: n };
  }

  async audienceCount(tenantId: string, tags: unknown, match: TagMatch) {
    const list = normalizeTags(tags ?? []);
    if (list.length === 0) return { count: 0 };
    return { count: await this.store.countAudience(tenantId, list, match) };
  }

  // كل رسالة جاية: نسجّل الرقم في الدفتر، ولو هي STOP / START نغيّر الاشتراك
  async handleInbound(tenantId: string, rawPhone: string, name: string | null, text: string, at = new Date()): Promise<OptIntent> {
    const phone = normalizePhone(rawPhone);
    if (!phone) return null;
    const intent = optIntent(text);
    if (intent) await this.store.setOptOut(tenantId, phone, intent === "OUT", at);
    await this.store.touchInbound(tenantId, phone, name, at);
    return intent;
  }
}

export function contactsCsv(rows: ContactRow[]) {
  const keys: string[] = [];
  const attrs = rows.map((r) => normalizeAttributes(r.attributes));
  for (const a of attrs) for (const k of Object.keys(a)) if (!keys.includes(k)) keys.push(k);
  const head = ["Phone", "Name", "Tags", "Status", "Source", "Added", "Last message", ...keys, "Notes"];
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  const lines = rows.map((r, i) => ["+" + r.phone, r.name ?? "", r.tags.join(", "), r.optedOut ? "Unsubscribed" : "Subscribed", r.source, day(r.createdAt), day(r.lastInboundAt), ...keys.map((k) => attrs[i][k] ?? ""), r.notes ?? ""]);
  return "\uFEFF" + [head, ...lines].map((l) => l.map(csvCell).join(",")).join("\r\n");
}
