import type { Request } from "express";

// دولة الزائر = السيرفر هو اللي بيحددها (عشان محدش يشوف/يدفع بأسعار دولة تانية).
// الترتيب: VISITOR_COUNTRY_OVERRIDE (للاختبار المحلي بس) → الـ IP (مكتبة geoip-country لو متثبّتة)
// → لو المكتبة مش موجودة بس: الدولة اللي الصفحة بعتتها (من توقيت الجهاز) زي الأول.

type Lookup = (ip: string) => { country?: string } | null;
let lookup: Lookup | null | undefined;

function ipLookup(): Lookup | null {
  if (lookup === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      lookup = (require("geoip-country") as { lookup: Lookup }).lookup;
    } catch {
      lookup = null;
    }
  }
  return lookup;
}

const CODE = /^[A-Z]{2}$/;

// IP الزائر الحقيقي ورا بروكسي Railway: X-Real-IP، وإلا آخر عنوان في X-Forwarded-For (اللي البروكسي ضافه)
export function clientIp(req: Pick<Request, "headers" | "socket">): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const xff = req.headers["x-forwarded-for"];
  const list = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) return list[list.length - 1];
  return (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
}

export interface VisitorCountry {
  country: string | null;
  // true = اتحددت من السيرفر (الزائر مايقدرش يغيّرها)
  locked: boolean;
}

export function visitorCountry(req: Pick<Request, "headers" | "socket">, claimed?: unknown): VisitorCountry {
  const forced = String(process.env.VISITOR_COUNTRY_OVERRIDE ?? "").toUpperCase();
  if (forced) return { country: CODE.test(forced) ? forced : null, locked: true };
  const find = ipLookup();
  if (find) {
    let code = "";
    try {
      code = String(find(clientIp(req))?.country ?? "").toUpperCase();
    } catch {
      code = "";
    }
    return { country: CODE.test(code) ? code : null, locked: true };
  }
  const hint = typeof claimed === "string" ? claimed.toUpperCase() : "";
  return { country: CODE.test(hint) ? hint : null, locked: false };
}
