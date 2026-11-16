import { describe, expect, it, vi } from "vitest";

vi.mock("../config/db", () => ({ prisma: {} }));

import { SmsService } from "../modules/sms/sms.service";
import { FakeSmsProvider, InfobipSmsProvider, TwilioSmsProvider } from "../modules/sms/sms-provider";
import { grantIncludedSms } from "../modules/sms/sms-subscription";
import type { CampaignRow, SmsStore } from "../modules/sms/sms.repository";

// مخزن في الذاكرة بنفس قواعد قاعدة البيانات (خصم بشرط الرصيد، استرجاع، حالات الحملة)
function memStore(opts: { balance?: number; unlimited?: boolean } = {}) {
  const st = {
    balance: opts.balance ?? 0,
    unlimited: !!opts.unlimited,
    tx: [] as { amount: number; reason: string; refId?: string | null }[],
    messages: [] as any[],
    campaigns: new Map<string, CampaignRow>(),
    contacts: [] as { phone: string; name: string; tags: string[]; optedOut: boolean }[],
  };
  let n = 0;
  const store: SmsStore = {
    account: async () => ({ balance: st.balance, senderName: null, unlimited: st.unlimited }),
    tenantExists: async () => true,
    setSenderName: async () => {},
    spend: async (_t, amount, e) => {
      if (!st.unlimited) {
        if (st.balance < amount) return false;
        st.balance -= amount;
      }
      st.tx.push({ amount: -amount, reason: e.reason, refId: e.refId });
      return true;
    },
    adjust: async (_t, amount, e) => {
      if (!(st.unlimited && e.reason === "REFUND")) {
        if (st.balance + amount < 0) return null;
        st.balance += amount;
      }
      st.tx.push({ amount, reason: e.reason, refId: e.refId });
      return st.balance;
    },
    transactions: async () => st.tx,
    createMessage: async (m) => {
      const id = m.id ?? `m${++n}`;
      st.messages.push({ ...m, id });
      return { id };
    },
    updateMessage: async (id, d) => Object.assign(st.messages.find((m) => m.id === id), d),
    listMessages: async () => ({ items: st.messages, total: st.messages.length }),
    monthUsage: async () => ({ messages: 0, segments: 0 }),
    campaignMessages: async (_t, cid) => st.messages.filter((m) => m.campaignId === cid),
    sentPhonesForCampaign: async (cid) => new Set(st.messages.filter((m) => m.campaignId === cid && m.status === "SENT").map((m) => m.to)),
    sentSegmentsForCampaign: async (cid) => st.messages.filter((m) => m.campaignId === cid && m.status === "SENT").reduce((s, m) => s + m.segments, 0),
    listCampaigns: async () => [...st.campaigns.values()],
    getCampaign: async (_t, id) => st.campaigns.get(id) ?? null,
    createCampaign: async (tenantId, i) => {
      const c = { id: `c${++n}`, tenantId, name: i.name, body: i.body, audienceTags: i.audienceTags, audienceMatch: i.audienceMatch, recipients: i.recipients, status: "DRAFT", scheduledAt: null, sendingAt: null, sentAt: null, total: 0, sentCount: 0, failedCount: 0, segmentsUsed: 0, lastError: null, createdAt: new Date(), updatedAt: new Date() } as CampaignRow;
      st.campaigns.set(c.id, c);
      return c;
    },
    updateDraft: async () => true,
    deleteDraft: async () => true,
    claim: async (_t, id, from) => {
      const c = st.campaigns.get(id);
      if (!c || !from.includes(c.status as never)) return false;
      c.status = "SENDING";
      return true;
    },
    release: async (id, status, lastError) => Object.assign(st.campaigns.get(id)!, { status, lastError: lastError ?? null }) && undefined,
    startSending: async (id, d) => void Object.assign(st.campaigns.get(id)!, d),
    progress: async (id, d) => void Object.assign(st.campaigns.get(id)!, d),
    finish: async (id, d) => void Object.assign(st.campaigns.get(id)!, d),
    schedule: async (_t, id, at) => {
      const c = st.campaigns.get(id)!;
      if (!["DRAFT", "FAILED", "SCHEDULED"].includes(c.status)) return false;
      Object.assign(c, { status: "SCHEDULED", scheduledAt: at });
      return true;
    },
    unschedule: async () => true,
    dueCampaigns: async (now) => [...st.campaigns.values()].filter((c) => c.status === "SCHEDULED" && c.scheduledAt! <= now).map((c) => ({ id: c.id, tenantId: c.tenantId })),
    staleSending: async () => [],
    audienceByTags: async (_t, tags, match) => {
      const has = (c: { tags: string[] }) => (match === "all" ? tags.every((t) => c.tags.includes(t)) : tags.some((t) => c.tags.includes(t)));
      return { recipients: st.contacts.filter((c) => has(c) && !c.optedOut), optedOut: st.contacts.filter((c) => has(c) && c.optedOut).length };
    },
    optedOutPhones: async (_t, phones) => new Set(st.contacts.filter((c) => c.optedOut && phones.includes(c.phone)).map((c) => c.phone)),
    tagCounts: async () => ({ tags: [], contacts: 0, optedOut: 0 }),
  };
  return { st, store };
}

describe("SmsService", () => {
  it("no provider → 503 and nothing charged", async () => {
    const { st, store } = memStore({ balance: 10 });
    const svc = new SmsService(store, () => null);
    await expect(svc.sendOne("t", null, "+97455551234", "hi")).rejects.toMatchObject({ status: 503, code: "SMS_NOT_CONFIGURED" });
    expect(st.balance).toBe(10);
    expect(st.tx).toHaveLength(0);
  });

  it("charges segments before sending, refunds when the provider fails", async () => {
    const { st, store } = memStore({ balance: 10 });
    const fake = new FakeSmsProvider(["97466667777"]);
    const svc = new SmsService(store, () => fake);
    const ok = await svc.sendOne("t", null, "+974 5555 1234", "م".repeat(71));
    expect(ok.segments).toBe(2);
    expect(st.balance).toBe(8);
    await expect(svc.sendOne("t", null, "+97466667777", "hello")).rejects.toMatchObject({ status: 502, code: "SMS_SEND_FAILED" });
    expect(st.balance).toBe(8);
    expect(st.tx.map((t) => t.reason)).toEqual(["SEND", "SEND", "REFUND"]);
    expect(st.messages.map((m) => m.status)).toEqual(["SENT", "FAILED"]);
  });

  it("refuses when the balance is too low", async () => {
    const { st, store } = memStore({ balance: 1 });
    const svc = new SmsService(store, () => new FakeSmsProvider());
    await expect(svc.sendOne("t", null, "+97455551234", "a".repeat(200))).rejects.toMatchObject({ status: 402, code: "INSUFFICIENT_SMS_BALANCE" });
    expect(st.balance).toBe(1);
    expect(st.messages).toHaveLength(0);
  });

  it("platform owner: unlimited, usage still logged", async () => {
    const { st, store } = memStore({ balance: 0, unlimited: true });
    const svc = new SmsService(store, () => new FakeSmsProvider());
    await svc.sendOne("t", null, "+97455551234", "hi");
    expect(st.balance).toBe(0);
    expect(st.tx).toEqual([{ amount: -1, reason: "SEND", refId: st.messages[0].id }]);
  });

  it("campaign: reserves the whole cost, skips opted-out, refunds failures, second send = 409", async () => {
    const { st, store } = memStore({ balance: 100 });
    st.contacts.push(
      { phone: "97455550001", name: "Sara", tags: ["vip"], optedOut: false },
      { phone: "97455550002", name: "Omar", tags: ["vip"], optedOut: true },
      { phone: "97455550003", name: "", tags: ["vip", "new"], optedOut: false },
      { phone: "97455550004", name: "Ali", tags: ["vip"], optedOut: false }
    );
    const fake = new FakeSmsProvider(["97455550004"]);
    const svc = new SmsService(store, () => fake);
    const { campaign } = await svc.createCampaign("t", { name: "Sale", body: "Hi {name}, sale!", audienceTags: ["VIP"] });
    const est = await svc.estimate("t", campaign.id);
    expect(est).toMatchObject({ recipients: 3, skippedOptedOut: 1, totalSegments: 3, enough: true, balanceAfter: 97 });
    const r = await svc.start("t", campaign.id);
    expect(r.total).toBe(3);
    await expect(svc.start("t", campaign.id)).rejects.toMatchObject({ status: 409 });
    await svc.waitFor(campaign.id);
    const c = st.campaigns.get(campaign.id)!;
    expect(c).toMatchObject({ status: "SENT", sentCount: 2, failedCount: 1, segmentsUsed: 2 });
    expect(st.balance).toBe(98);
    expect(fake.sent.map((s) => s.body).sort()).toEqual(["Hi Sara, sale!", "Hi, sale!"]);
  });

  it("campaign without enough balance is refused and goes back to draft", async () => {
    const { st, store } = memStore({ balance: 1 });
    const svc = new SmsService(store, () => new FakeSmsProvider());
    const { campaign, paste } = await svc.createCampaign("t", { name: "x", body: "Hello", pasted: "+97455550001\n+97455550002\nbad" });
    expect(paste).toMatchObject({ added: 2, invalid: [{ line: 3, text: "bad" }] });
    await expect(svc.start("t", campaign.id)).rejects.toMatchObject({ status: 402 });
    expect(st.campaigns.get(campaign.id)!.status).toBe("DRAFT");
    expect(st.balance).toBe(1);
  });

  it("scheduled campaign is sent by runDue", async () => {
    const { st, store } = memStore({ balance: 5 });
    const svc = new SmsService(store, () => new FakeSmsProvider());
    const { campaign } = await svc.createCampaign("t", { name: "x", body: "Hello", pasted: "+97455550001" });
    const now = new Date();
    await expect(svc.schedule("t", campaign.id, new Date(now.getTime() + 10_000), now)).rejects.toMatchObject({ status: 400 });
    await svc.schedule("t", campaign.id, new Date(now.getTime() + 120_000), now);
    expect((await svc.runDue(now)).started).toBe(0);
    expect((await svc.runDue(new Date(now.getTime() + 121_000))).started).toBe(1);
    await svc.waitFor(campaign.id);
    expect(st.campaigns.get(campaign.id)!.status).toBe("SENT");
    expect(st.balance).toBe(4);
  });
});

describe("providers (request shape)", () => {
  it("Twilio and Infobip send the right request", async () => {
    const calls: { url: string; init: any }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes("twilio")) return new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 });
      return new Response(JSON.stringify({ messages: [{ messageId: "ib1", status: { groupName: "PENDING" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const tw = await new TwilioSmsProvider({ accountSid: "AC1", authToken: "tok", from: "+1555", baseUrl: "http://twilio.local" }).send({ to: "97455551234", body: "hi", sender: "BlueField" });
      expect(tw).toEqual({ ok: true, providerId: "SM1" });
      expect(calls[0].url).toBe("http://twilio.local/2010-04-01/Accounts/AC1/Messages.json");
      expect(calls[0].init.headers.Authorization).toBe("Basic " + Buffer.from("AC1:tok").toString("base64"));
      expect(new URLSearchParams(calls[0].init.body).get("To")).toBe("+97455551234");
      expect(new URLSearchParams(calls[0].init.body).get("From")).toBe("BlueField");
      const ib = await new InfobipSmsProvider({ baseUrl: "http://infobip.local", apiKey: "k", from: "BlueField" }).send({ to: "97455551234", body: "hi" });
      expect(ib).toEqual({ ok: true, providerId: "ib1" });
      expect(calls[1].url).toBe("http://infobip.local/sms/2/text/advanced");
      expect(calls[1].init.headers.Authorization).toBe("App k");
      expect(JSON.parse(calls[1].init.body)).toEqual({ messages: [{ destinations: [{ to: "97455551234" }], text: "hi", from: "BlueField" }] });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("grantIncludedSms", () => {
  it("adds once per order", async () => {
    const rows: any[] = [];
    let balance = 0;
    const tx = {
      smsCreditTransaction: {
        findFirst: async ({ where }: any) => rows.find((r) => r.refId === where.refId && r.reason === where.reason) ?? null,
        create: async ({ data }: any) => rows.push(data),
      },
      smsSettings: { upsert: async ({ update }: any) => (balance += update.balance.increment) },
    };
    expect(await grantIncludedSms(tx, "t", "yearly", "order1")).toBe(2400);
    expect(await grantIncludedSms(tx, "t", "yearly", "order1")).toBe(0);
    expect(balance).toBe(2400);
    expect(rows).toHaveLength(1);
  });
});
