// قرار رد ملف الصورة/الفيديو: 304 لو المتصفح عنده نفس النسخة، 206 لجزء (تقديم الفيديو)،
// 416 لو الجزء المطلوب برّه الملف، وإلا 200 الملف كله. الملفات مابتتغيرش، فالـ ETag ثابت
export const MAX_RANGE_CHUNK = 4 * 1024 * 1024; // جزء مفتوح (bytes=N-) بنرجّع منه لحد 4MB

export type AssetResponsePlan = { status: 200 } | { status: 304 } | { status: 416 } | { status: 206; start: number; end: number };

export function assetEtag(a: { id: string; size: number }): string {
  return `"${a.id}-${a.size}"`;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export function planAssetResponse(opts: { size: number; etag: string; ifNoneMatch?: string; range?: string }): AssetResponsePlan {
  if (etagMatches(opts.ifNoneMatch, opts.etag)) return { status: 304 };
  const range = opts.range?.trim();
  if (!range) return { status: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  // أكتر من جزء أو صيغة غريبة: نرجّع الملف كله (مسموح في HTTP)
  if (!m || (m[1] === "" && m[2] === "")) return { status: 200 };
  const size = opts.size;
  if (size === 0) return { status: 416 };
  let start: number;
  let end: number;
  if (m[1] === "") {
    // bytes=-N = آخر N بايت
    const suffix = Number(m[2]);
    if (suffix === 0) return { status: 416 };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (start >= size) return { status: 416 };
    end = m[2] === "" ? Math.min(size - 1, start + MAX_RANGE_CHUNK - 1) : Math.min(size - 1, Number(m[2]));
    if (end < start) return { status: 416 };
  }
  return { status: 206, start, end };
}
