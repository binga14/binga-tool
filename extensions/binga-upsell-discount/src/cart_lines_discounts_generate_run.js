const UPSALE_MARKER_KEY = "_binga_upsell";
const UPSALE_MARKER_VALUE = "1";

function clampPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(90, Math.round(x)));
}

function gidToId(gid) {
  if (!gid) return null;
  const s = String(gid);
  return s.split("/").pop() || s;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// Works whether Shopify gives you:
// - attribute: {key,value}
// - attributes: [{key,value}, ...]
function attrsToMap(attrLike) {
  const out = {};
  if (!attrLike) return out;

  const list = Array.isArray(attrLike) ? attrLike : [attrLike];
  for (const a of list) {
    const k = a?.key;
    if (!k) continue;
    out[String(k)] = String(a?.value ?? "");
  }
  return out;
}

// ✅ Named export that the build expects
export function cartLinesDiscountsGenerateRun(input) {
  const metaValue =
    input?.discount?.metafield?.value ??
    input?.discountNode?.metafield?.value ??
    null;

  const cfg = safeJsonParse(metaValue, {}) || {};
  const defaultPercent = clampPercent(cfg?.defaultPercent ?? 10);

  const overrides =
    cfg?.overrides && typeof cfg.overrides === "object" ? cfg.overrides : {};

  const discounts = [];
  const lines = input?.cart?.lines || [];

  for (const line of lines) {
    const lineAttrs = attrsToMap(line?.attribute ?? line?.attributes);

    // only apply to upsell items
    const isUpsell = lineAttrs[UPSALE_MARKER_KEY] === UPSALE_MARKER_VALUE;
    if (!isUpsell) continue;

    const productId = gidToId(line?.merchandise?.product?.id);
    if (!productId) continue;

    let pct = overrides[productId];
    pct = pct === undefined ? defaultPercent : clampPercent(pct);

    if (pct <= 0) continue;

    discounts.push({
      targets: [{ cartLine: { id: line.id } }],
      value: { percentage: { value: pct } },
      message: `Binga ${pct}% off`,
    });
  }

  return {
    // no enum import needed
    discountApplicationStrategy: "FIRST",
    discounts,
  };
}

// optional default export (safe)
export default cartLinesDiscountsGenerateRun;
