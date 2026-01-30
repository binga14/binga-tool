// @ts-check
import { ProductDiscountSelectionStrategy } from "../generated/api";

const MARKER_KEY = "_binga_upsell";
const DISCOUNT_PERCENT = 10;

export function cartLinesDiscountsGenerateRun(input) {
  const targets = (input.cart.lines || [])
    .filter((line) => (line.attribute?.value || "") === "1")
    .map((line) => ({ cartLine: { id: line.id } }));

  // Nothing to discount
  if (!targets.length) return { operations: [] };

  return {
    operations: [
      {
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.First,
          candidates: [
            {
              message: "10% off (Binga recommendation)",
              targets,
              value: {
                percentage: {
                  value: DISCOUNT_PERCENT,
                },
              },
            },
          ],
        },
      },
    ],
  };
}
