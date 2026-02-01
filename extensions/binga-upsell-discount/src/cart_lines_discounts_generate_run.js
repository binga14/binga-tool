import { ProductDiscountSelectionStrategy } from "../generated/api";

const MARKER_VALUE = "1";

function gidToId(gid) {
  return String(gid || "").split("/").pop() || String(gid || "");
}

function clampPercent(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(90, Math.round(x)));
}

function readConfig(input) {
  try {
    const raw = input?.discount?.metafield?.value;
    if (!raw) return { defaultPercent: 10, overrides: {} };

    const parsed = JSON.parse(raw);
    const defaultPercent = clampPercent(parsed?.defaultPercent ?? 10);
    const overridesRaw = parsed?.overrides ?? {};
    const overrides = {};

    for (const k of Object.keys(overridesRaw)) {
      overrides[String(k)] = clampPercent(overridesRaw[k]);
    }

    return { defaultPercent, overrides };
  } catch {
    return { defaultPercent: 10, overrides: {} };
  }
}

export function cartLinesDiscountsGenerateRun(input) {
  const cfg = readConfig(input);

  // percent -> targets[]
  const buckets = new Map();

  for (const line of input?.cart?.lines || []) {
    const marker = line?.attribute?.value || "";
    if (marker !== MARKER_VALUE) continue;

    const productGid = line?.merchandise?.product?.id;
    const productId = gidToId(productGid);

    const pct =
      cfg.overrides[productId] !== undefined ? cfg.overrides[productId] : cfg.defaultPercent;

    const percent = clampPercent(pct);
    if (percent <= 0) continue;

    if (!buckets.has(percent)) buckets.set(percent, []);
    buckets.get(percent).push({ cartLine: { id: line.id } });
  }

  if (buckets.size === 0) return { operations: [] };

  const operations = [];
  for (const [percent, targets] of buckets.entries()) {
    operations.push({
      productDiscountsAdd: {
        selectionStrategy: ProductDiscountSelectionStrategy.First,
        candidates: [
          {
            message: `${percent}% off (Binga recommendation)`,
            targets,
            value: { percentage: { value: percent } },
          },
        ],
      },
    });
  }

  return { operations };
}
