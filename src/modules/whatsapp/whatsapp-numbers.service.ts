import { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../core/errors";
import { assertTenantOwns } from "../../utils/tenant-owned";
import { decryptToken, encryptToken } from "../social/token-crypto";
import { verifyWhatsappConnection } from "./whatsapp.service";

// أكتر من رقم واتساب لنفس الشركة (رقم لكل فرع مثلًا). الرقم الأساسي فاضل زي ما هو في WhatsappSettings،
// والأرقام الإضافية هنا. القاعدة: الرد بيطلع من نفس الرقم اللي العميل كتب عليه

export const MAX_EXTRA_NUMBERS = 10;

export interface Sender {
  token: string;
  phoneNumberId: string;
  // null = الرقم الأساسي
  numberId: string | null;
  label: string;
}

export interface NumberInput {
  label: string;
  phoneNumberId: string;
  wabaId?: string | null;
  branchId?: string | null;
  // فاضي = توكن الرقم الأساسي
  accessToken?: string | null;
}

type Verifier = typeof verifyWhatsappConnection;

export class WhatsappNumbersService {
  constructor(
    private readonly db: PrismaClient,
    private readonly verify: Verifier = verifyWhatsappConnection
  ) {}

  private async main(tenantId: string) {
    return this.db.whatsappSettings.findUnique({ where: { tenantId }, select: { isConnected: true, metaAccessToken: true, metaPhoneNumberId: true, displayPhoneNumber: true } });
  }

  private tokenOf(row: { accessToken: string | null }, mainToken: string | null | undefined): string | null {
    if (!row.accessToken) return mainToken ?? null;
    try {
      return decryptToken(row.accessToken);
    } catch {
      return null;
    }
  }

  // أنهي رقم نبعت منه: رقم محدد، وإلا نفس الرقم اللي العميل كتب عليه آخر مرة، وإلا الأساسي
  async senderFor(tenantId: string, opts: { customerPhone?: string | null; numberId?: string | null } = {}): Promise<Sender | null> {
    const main = await this.main(tenantId);
    const mainSender: Sender | null =
      main?.isConnected && main.metaAccessToken && main.metaPhoneNumberId ? { token: main.metaAccessToken, phoneNumberId: main.metaPhoneNumberId, numberId: null, label: "Main number" } : null;
    let wanted: { id: string } | null = null;
    if (opts.numberId && opts.numberId !== "main") wanted = { id: opts.numberId };
    else if (!opts.numberId && opts.customerPhone) {
      const last = await this.db.whatsappMessage.findFirst({
        where: { tenantId, contactPhone: opts.customerPhone.replace(/[^\d]/g, ""), direction: "IN", phoneNumberId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { phoneNumberId: true },
      });
      if (last?.phoneNumberId && last.phoneNumberId !== main?.metaPhoneNumberId) {
        const extra = await this.db.whatsappNumber.findFirst({ where: { tenantId, phoneNumberId: last.phoneNumberId, isConnected: true }, select: { id: true } });
        if (extra) wanted = extra;
      }
    }
    if (!wanted) return mainSender;
    const row = await this.db.whatsappNumber.findFirst({ where: { id: wanted.id, tenantId } });
    if (!row) {
      if (opts.numberId) throw new NotFoundError("That WhatsApp number isn't on this company.");
      return mainSender;
    }
    const token = this.tokenOf(row, main?.metaAccessToken);
    if (!row.isConnected || !token) return opts.numberId ? null : mainSender;
    return { token, phoneNumberId: row.phoneNumberId, numberId: row.id, label: row.label };
  }

  // رقم الـ webhook ده تبع الشركة دي؟ (الأساسي أو إضافي متوصل)
  async ownsIncoming(tenantId: string, phoneNumberId: string, mainPhoneNumberId: string | null): Promise<boolean> {
    if (!mainPhoneNumberId || phoneNumberId === mainPhoneNumberId) return true;
    return (await this.db.whatsappNumber.count({ where: { tenantId, phoneNumberId, isConnected: true } })) > 0;
  }

  // الشركات اللي عندها الرقم ده كرقم إضافي (للـ platform webhook)
  async tenantsWithExtra(phoneNumberId: string): Promise<string[]> {
    const rows = await this.db.whatsappNumber.findMany({ where: { phoneNumberId, isConnected: true }, orderBy: { lastVerifiedAt: "desc" }, take: 1, select: { tenantId: true } });
    return rows.map((r) => r.tenantId);
  }

  // الفرع لازم يكون تبع نفس الشركة (رسالة واضحة بدل 500)
  private async ownBranch(tenantId: string, branchId: string) {
    try {
      await assertTenantOwns(tenantId, { branchIds: [branchId] });
    } catch {
      throw new ValidationError("That branch isn't in this company.");
    }
  }

  async list(tenantId: string) {
    const [rows, main, branches] = await Promise.all([
      this.db.whatsappNumber.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
      this.main(tenantId),
      this.db.branch.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    return {
      main: main?.metaPhoneNumberId ? { phoneNumberId: main.metaPhoneNumberId, displayPhoneNumber: main.displayPhoneNumber, isConnected: main.isConnected } : null,
      numbers: rows.map((r) => ({
        id: r.id,
        label: r.label,
        branchId: r.branchId,
        branchName: r.branchId ? branchName.get(r.branchId) ?? null : null,
        phoneNumberId: r.phoneNumberId,
        wabaId: r.wabaId,
        displayPhoneNumber: r.displayPhoneNumber,
        ownToken: Boolean(r.accessToken),
        isConnected: r.isConnected,
        lastVerifiedAt: r.lastVerifiedAt,
        lastError: r.lastError,
      })),
    };
  }

  private async check(tenantId: string, phoneNumberId: string, wabaId: string | null | undefined, token: string | null) {
    if (!token) return { ok: false as const, error: "Connect the main WhatsApp number first, or paste an access token for this number." };
    const v = await this.verify(token, phoneNumberId, wabaId ?? null);
    return v.ok ? { ok: true as const, displayPhoneNumber: v.displayPhoneNumber ?? null } : { ok: false as const, error: v.error ?? "Meta didn't accept this number" };
  }

  async add(tenantId: string, input: NumberInput) {
    const main = await this.main(tenantId);
    if (main?.metaPhoneNumberId === input.phoneNumberId) throw new ValidationError("That's already your main WhatsApp number.");
    if ((await this.db.whatsappNumber.count({ where: { tenantId } })) >= MAX_EXTRA_NUMBERS) throw new ValidationError(`You can add up to ${MAX_EXTRA_NUMBERS} extra numbers.`);
    if (await this.db.whatsappNumber.count({ where: { tenantId, phoneNumberId: input.phoneNumberId } })) throw new ValidationError("This number is already added.");
    if (input.branchId) await this.ownBranch(tenantId, input.branchId);
    const ownToken = input.accessToken?.trim() || null;
    const v = await this.check(tenantId, input.phoneNumberId, input.wabaId, ownToken ?? main?.metaAccessToken ?? null);
    const row = await this.db.whatsappNumber.create({
      data: {
        tenantId,
        label: input.label.trim(),
        branchId: input.branchId ?? null,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId ?? null,
        accessToken: ownToken ? encryptToken(ownToken) : null,
        isConnected: v.ok,
        displayPhoneNumber: v.ok ? v.displayPhoneNumber : null,
        lastVerifiedAt: v.ok ? new Date() : null,
        lastError: v.ok ? null : v.error,
      },
    });
    return { id: row.id, verified: v.ok, error: v.ok ? null : v.error };
  }

  async reverify(tenantId: string, id: string) {
    const row = await this.db.whatsappNumber.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundError("Number not found");
    const main = await this.main(tenantId);
    const v = await this.check(tenantId, row.phoneNumberId, row.wabaId, this.tokenOf(row, main?.metaAccessToken));
    await this.db.whatsappNumber.update({
      where: { id },
      data: { isConnected: v.ok, ...(v.ok ? { displayPhoneNumber: v.displayPhoneNumber, lastVerifiedAt: new Date(), lastError: null } : { lastError: v.error }) },
    });
    return { verified: v.ok, error: v.ok ? null : v.error };
  }

  async update(tenantId: string, id: string, input: { label?: string; branchId?: string | null }) {
    if (input.branchId) await this.ownBranch(tenantId, input.branchId);
    const r = await this.db.whatsappNumber.updateMany({ where: { id, tenantId }, data: { ...(input.label ? { label: input.label.trim() } : {}), ...(input.branchId !== undefined ? { branchId: input.branchId } : {}) } });
    if (!r.count) throw new NotFoundError("Number not found");
  }

  async remove(tenantId: string, id: string) {
    const r = await this.db.whatsappNumber.deleteMany({ where: { id, tenantId } });
    if (!r.count) throw new NotFoundError("Number not found");
  }

  // اسم الرقم اللي كل محادثة شغالة عليه (لـ Team Inbox)
  async labelsByPhoneNumberId(tenantId: string): Promise<Map<string, string>> {
    const [rows, main] = await Promise.all([this.db.whatsappNumber.findMany({ where: { tenantId }, select: { phoneNumberId: true, label: true } }), this.main(tenantId)]);
    const m = new Map(rows.map((r) => [r.phoneNumberId, r.label]));
    if (main?.metaPhoneNumberId) m.set(main.metaPhoneNumberId, "Main number");
    return m;
  }
}
