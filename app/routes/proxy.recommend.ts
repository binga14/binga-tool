import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const NS = "$app:binga";
const SHOP_KEY = "upsell_discount_config";

type Urgency = "none" | "low" | "medium" | "high";

function gidToId(gid: string) {
    return gid.split("/").pop() || gid;
}

function clampPercent(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(90, Math.round(n)));
}

function isUrgency(v: any): v is Urgency {
    return v === "none" || v === "low" || v === "medium" || v === "high";
}

function asObject(v: any) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function urgencyScore(u: Urgency | undefined): number {
    switch (u) {
        case "high":
            return 1.0;
        case "medium":
            return 0.66;
        case "low":
            return 0.33;
        default:
            return 0.0; // none / missing
    }
}

function safeJsonParse<T>(s: string | null, fallback: T): T {
    if (!s) return fallback;
    try {
        const j = JSON.parse(s);
        return (j ?? fallback) as T;
    } catch {
        return fallback;
    }
}

/**
 * Reads the shop metafield config:
 * {
 *   defaultPercent: number,
 *   overrides: { [productId]: number },
 *   urgencies: { [productId]: "low"|"medium"|"high" }
 * }
 */
async function getShopConfig(admin: any) {
    const resp = await admin.graphql(`
    query GetConfig {
      shop {
        metafield(namespace: "${NS}", key: "${SHOP_KEY}") { value }
      }
    }
  `);

    const j = await resp.json();
    const raw = j?.data?.shop?.metafield?.value;

    const parsed = safeJsonParse<any>(raw, {});
    const defaultPercent = clampPercent(Number(parsed?.defaultPercent ?? 10));

    const overridesRaw = asObject(parsed?.overrides);
    const urgenciesRaw = asObject(parsed?.urgencies);

    const overrides: Record<string, number> = {};
    Object.keys(overridesRaw).forEach((k) => {
        overrides[String(k)] = clampPercent(Number(overridesRaw[k]));
    });

    const urgencies: Record<string, Urgency> = {};
    Object.keys(urgenciesRaw).forEach((k) => {
        const v = urgenciesRaw[k];
        if (isUrgency(v) && v !== "none") urgencies[String(k)] = v; // store only low/medium/high
    });

    return { defaultPercent, overrides, urgencies };
}

type ViewsMap = Record<string, number>;

function parseViewsParam(raw: string | null): ViewsMap {
    // client sends encodeURIComponent(JSON.stringify(map))
    const decoded = raw ? decodeURIComponent(raw) : "";
    const obj = safeJsonParse<any>(decoded, {});
    const out: ViewsMap = {};
    Object.keys(asObject(obj)).forEach((k) => {
        const n = Number(obj[k]);
        if (Number.isFinite(n) && n > 0) out[String(k)] = n;
    });
    return out;
}

function scoreFromViews(views: ViewsMap, productId: string) {
    const v = Number(views[productId] || 0);
    if (!Number.isFinite(v) || v <= 0) return 0;

    // soft scale: 1 view small, 5 views stronger, 10+ saturates
    // 0..1 range
    return Math.min(1, Math.log(1 + v) / Math.log(1 + 10));
}

export async function loader({ request }: LoaderFunctionArgs) {
    const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
    };

    try {
        const { admin, session } = await authenticate.public.appProxy(request);

        if (!admin || !session?.accessToken) {
            return new Response(
                JSON.stringify({ ok: false, error: "No offline session. Reinstall app." }),
                { status: 401, headers }
            );
        }

        const url = new URL(request.url);

        const exclude = (url.searchParams.get("exclude") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const limitRaw = Number(url.searchParams.get("limit") || "3");
        const limit = Math.max(1, Math.min(6, Number.isFinite(limitRaw) ? limitRaw : 3));

        const views = parseViewsParam(url.searchParams.get("views"));

        const cfg = await getShopConfig(admin);

        // Fetch MORE than we need so we can filter + still return `limit`
        const resp = await admin.graphql(
            `#graphql
      query Products($first: Int!) {
        products(first: $first, query: "status:active published_status:published") {
          nodes {
            id
            title
            handle
            featuredImage { url }
            variants(first: 10) {
              nodes { id price availableForSale }
            }
          }
        }
      }`,
            { variables: { first: 80 } }
        );

        const j = await resp.json();
        const products = j?.data?.products?.nodes ?? [];

        // Candidates (exclude cart product ids etc.)
        const candidates = products
            .filter((p: any) => !exclude.includes(gidToId(p.id)))
            .map((p: any) => {
                const pid = gidToId(p.id);

                // Pick first AVAILABLE variant, not just first variant
                const variants = p?.variants?.nodes ?? [];
                const vAvail = variants.find((v: any) => v?.availableForSale === true) || variants[0];
                if (!vAvail?.id) return null;

                const variantId = Number(gidToId(vAvail.id));
                if (!variantId) return null;

                const price = vAvail?.price ?? null;

                // discount percent = override or default
                const discountPercent =
                    cfg.overrides[pid] !== undefined ? clampPercent(cfg.overrides[pid]) : cfg.defaultPercent;

                const urgency = (cfg.urgencies[pid] ?? "none") as Urgency;

                // scoring
                const vScore = scoreFromViews(views, pid);
                const uScore = urgencyScore(urgency);
                const dScore = Math.min(1, discountPercent / 90);

                const score =
                    0.55 * vScore +
                    0.25 * uScore +
                    0.20 * dScore +
                    Math.random() * 0.02;

                return {
                    id: pid,
                    title: p.title,
                    url: `/products/${p.handle}`,
                    image: p?.featuredImage?.url ?? null,
                    variantId,
                    price,
                    available: vAvail?.availableForSale ?? true,

                    discountPercent,
                    urgency,
                    _score: score,
                };
            })
            .filter(Boolean)
            // only show purchasable variants
            .filter((p: any) => p.available !== false);

        // Sort by score descending, then pick `limit`
        candidates.sort((a: any, b: any) => (b._score ?? 0) - (a._score ?? 0));

        const picked = candidates.slice(0, limit).map((p: any) => {
            // remove internal score
            const { _score, ...rest } = p;
            return rest;
        });

        return new Response(
            JSON.stringify({
                ok: true,
                discountPercent: cfg.defaultPercent,
                products: picked,
            }),
            { headers }
        );
    } catch (e: any) {
        return new Response(
            JSON.stringify({ ok: false, error: e?.message || "Server error" }),
            { status: 500, headers }
        );
    }
}
