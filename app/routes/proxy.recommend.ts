import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const CONFIG_NS = "$app:binga";
const CONFIG_KEY = "upsell_discount_config";

function gidToId(gid: string) {
    return gid.split("/").pop() || gid;
}

function shuffle<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function clampPercent(n: number) {
    if (!Number.isFinite(n)) return 10;
    return Math.max(0, Math.min(90, Math.round(n)));
}

async function getDiscountPercent(admin: any) {
    try {
        const r = await admin.graphql(
            `#graphql
      query DiscountConfig {
        shop {
          metafield(namespace: "${CONFIG_NS}", key: "${CONFIG_KEY}") {
            value
          }
        }
      }`
        );
        const j = await r.json();
        const raw = j?.data?.shop?.metafield?.value;
        if (!raw) return 10;

        const parsed = JSON.parse(raw);
        return clampPercent(Number(parsed?.defaultPercent ?? 10));
    } catch {
        return 10;
    }
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

        const discountPercent = await getDiscountPercent(admin);

        // Fetch more than needed, we will filter + pick available variants
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

        const json = await resp.json();
        const products = json?.data?.products?.nodes ?? [];

        // Exclude items, then keep only products that have at least one available variant
        const candidates = products
            .filter((p: any) => !exclude.includes(gidToId(p.id)))
            .filter((p: any) => (p?.variants?.nodes || []).some((v: any) => v?.availableForSale === true));

        shuffle(candidates);

        const picked = candidates
            .slice(0, limit * 3) // extra buffer in case some mapping drops
            .map((p: any) => {
                const variants = p?.variants?.nodes || [];
                const v = variants.find((x: any) => x?.availableForSale === true) || variants[0];

                return {
                    id: gidToId(p.id),
                    title: p.title,
                    url: `/products/${p.handle}`,
                    image: p.featuredImage?.url ?? null,
                    variantId: v?.id ? Number(gidToId(v.id)) : null,
                    price: v?.price ?? null,
                    available: v?.availableForSale ?? false,
                };
            })
            .filter((p: any) => p.variantId && p.available === true)
            .slice(0, limit);

        return new Response(JSON.stringify({ ok: true, discountPercent, products: picked }), { headers });
    } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || "Server error" }), {
            status: 500,
            headers,
        });
    }
}
