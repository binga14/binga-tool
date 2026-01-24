import crypto from "crypto";
import type { LoaderFunctionArgs } from "react-router";
import shopify from "../shopify.server";

function validateProxySignature(url: URL) {
    const signature = url.searchParams.get("signature");
    if (!signature) return false;

    const entries: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
        if (key === "signature") return;
        entries.push([key, value]);
    });

    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const message = entries.map(([k, v]) => `${k}=${v}`).join("");

    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) return false;

    const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
    if (digest.length !== signature.length) return false;

    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

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

export async function loader({ request }: LoaderFunctionArgs) {
    const headers = { "Content-Type": "application/json" };

    try {
        const url = new URL(request.url);

        // IMPORTANT: when testing directly in browser, Shopify proxy signature won't exist
        // But real storefront requests via /apps/... WILL have signature.
        if (!validateProxySignature(url)) {
            return new Response(JSON.stringify({ ok: false, error: "Invalid proxy signature" }), {
                status: 401,
                headers,
            });
        }

        const shop = url.searchParams.get("shop");
        if (!shop) {
            return new Response(JSON.stringify({ ok: false, error: "Missing shop param" }), {
                status: 400,
                headers,
            });
        }

        const sessions = await shopify.sessionStorage.findSessionsByShop(shop);
        const offline = sessions.find((s: any) => s.isOnline === false && s.accessToken);

        if (!offline?.accessToken) {
            return new Response(JSON.stringify({ ok: false, error: "No offline session. Reinstall app." }), {
                status: 401,
                headers,
            });
        }

        const exclude = (url.searchParams.get("exclude") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        const limitRaw = Number(url.searchParams.get("limit") || "3");
        const limit = Math.max(1, Math.min(6, Number.isFinite(limitRaw) ? limitRaw : 3));

        // Admin GraphQL
        const graphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;

        const resp = await fetch(graphqlUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": offline.accessToken,
            },
            body: JSON.stringify({
                query: `
          query Products($first: Int!) {
            products(first: $first, query: "status:active") {
              nodes {
                id
                title
                handle
                featuredImage { url }
                variants(first: 1) {
                  nodes {
                    id
                    price
                    availableForSale
                  }
                }
              }
            }
          }
        `,
                variables: { first: 50 },
            }),
        });

        if (!resp.ok) {
            const text = await resp.text();
            return new Response(JSON.stringify({ ok: false, error: "Shopify API error", details: text }), {
                status: 500,
                headers,
            });
        }

        const json = await resp.json();
        if (json.errors) {
            return new Response(JSON.stringify({ ok: false, error: "GraphQL error", errors: json.errors }), {
                status: 500,
                headers,
            });
        }

        const products = json?.data?.products?.nodes ?? [];

        const candidates = products.filter((p: any) => !exclude.includes(gidToId(p.id)));
        shuffle(candidates);

        const picked = candidates.slice(0, limit).map((p: any) => {
            const v = p?.variants?.nodes?.[0];
            return {
                id: gidToId(p.id),
                title: p.title,
                url: `/products/${p.handle}`,
                image: p.featuredImage?.url ?? null,
                variantId: v?.id ? Number(gidToId(v.id)) : null,
                price: v?.price ?? null,
                available: v?.availableForSale ?? true,
            };
        }).filter((p: any) => p.variantId);

        return new Response(JSON.stringify({ ok: true, products: picked }), { headers });
    } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message || "Server error" }), {
            status: 500,
            headers,
        });
    }
}
