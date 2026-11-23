// اختبارات سباق على Postgres محلي حقيقي (تدقيق أمني P1): إطلاق إعلان مرتين + استرجاع رصيد SMS مرتين.
// ممنوع على الإنتاج. التشغيل:
//   DATABASE_URL=postgresql://... TS_NODE_TRANSPILE_ONLY=1 npx ts-node e2e/race-repos.e2e.ts
import { PrismaClient } from "@prisma/client";
import { PrismaAdsRepository } from "../src/modules/social/ads.repository";
import { PrismaSmsStore } from "../src/modules/sms/sms.repository";

if (/railway|rlwy|blue-field/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against production");
const db = new PrismaClient();
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(extra)}`);
};

async function main() {
  const tenant = await db.tenant.findFirstOrThrow({ select: { id: true } });
  const tag = Date.now().toString(36);

  // MSG-03: 6 ضغطات Boost في نفس اللحظة على نفس البوست → حملة واحدة بس
  const ads = new PrismaAdsRepository(db);
  const base = {
    tenantId: tenant.id, accountId: null, platform: "FACEBOOK", postExternalId: "race_" + tag, permalink: null, caption: null,
    adAccountId: "act_1", adAccountName: null, currency: "USD", objective: "REACH", dailyBudget: 5, startAt: new Date(), endAt: new Date(Date.now() + 864e5),
    targeting: { countries: ["QA"], cities: [], ageMin: 18, ageMax: 65, genders: "all" } as any, createdById: null,
  };
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => ads.createCampaign(base as any)));
  const created = results.filter((r) => r.status === "fulfilled").length;
  const busy = results.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 409).length;
  const rows = await db.socialAdCampaign.count({ where: { postExternalId: base.postExternalId } });
  check("MSG-03 6 concurrent boosts of one post → 1 campaign, 5 × 409", created === 1 && busy === 5 && rows === 1, { created, busy, rows });
  const other = await ads.createCampaign({ ...base, postExternalId: "race2_" + tag } as any).then(() => true, () => false);
  check("MSG-03 a different post can still be boosted (authorized)", other);

  // JOB-01: حملة SMS واقفة في النص - 5 instances بيحاولوا يقفلوها مع بعض → واحد بس ياخدها
  const sms = new PrismaSmsStore();
  const camp = await db.smsCampaign.create({ data: { tenantId: tenant.id, name: "race " + tag, body: "x", status: "SENDING", sendingAt: new Date(Date.now() - 3600_000) } });
  const claims = await Promise.all(Array.from({ length: 5 }, () => sms.claimStale(camp.id, new Date(Date.now() - 60_000))));
  check("JOB-01 5 concurrent stale claims → exactly one wins", claims.filter(Boolean).length === 1, claims);
  const fresh = await db.smsCampaign.create({ data: { tenantId: tenant.id, name: "fresh " + tag, body: "x", status: "SENDING", sendingAt: new Date() } });
  check("JOB-01 a campaign that is still sending is not claimed", !(await sms.claimStale(fresh.id, new Date(Date.now() - 60_000))));

  await db.socialAdCampaign.deleteMany({ where: { postExternalId: { in: [base.postExternalId, "race2_" + tag] } } });
  await db.smsCampaign.deleteMany({ where: { id: { in: [camp.id, fresh.id] } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
