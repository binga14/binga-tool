import { ProductDiscountSelectionStrategy } from "../generated/api";

const MARKER_KEY_VALUE = "1";

function readPercent(input) {
  try {
    const raw = input?.discount?.metafield?.value;
    if (!raw) return 10;
    const cfg = JSON.parse(raw);
    const n = Number(cfg?.defaultPercent ?? 10);
    if (!Number.isFinite(n)) return 10;
    return Math.max(0, Math.min(90, Math.round(n)));
  } catch {
    return 10;
  }
}

export function cartLinesDiscountsGenerateRun(input) {
  const percent = readPercent(input);

  const targets = (input.cart.lines || [])
    .filter((line) => (line.attribute?.value || "") === MARKER_KEY_VALUE)
    .map((line) => ({ cartLine: { id: line.id } }));

  if (!targets.length || percent <= 0) return { operations: [] };

  return {
    operations: [
      {
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
      },
    ],
  };
}
