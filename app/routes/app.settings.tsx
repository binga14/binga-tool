import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useMemo, useState } from "react";

import {
    Page,
    Layout,
    Card,
    TextField,
    Button,
    Banner,
    IndexTable,
    Thumbnail,
    InlineStack,
    Text,
    Pagination,
    Box,
    Select,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";

const NS = "$app:binga";
const SHOP_KEY = "upsell_discount_config";
const DISCOUNT_KEY = "upsell_discount_config";
const DISCOUNT_NODE_ID_KEY = "upsell_discount_discountNodeId";

const PAGE_SIZE = 10;

type Urgency = "none" | "low" | "medium" | "high";

function json(data: any, init?: ResponseInit) {
    return new Response(JSON.stringify(data), {
        ...init,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            Pragma: "no-cache",
            ...(init?.headers || {}),
        },
    });
}

function clampPercent(n: number) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(90, Math.round(n)));
}

function gidToId(gid: string) {
    return gid.split("/").pop() || gid;
}

function money(n: number) {
    if (!Number.isFinite(n)) return "—";
    return `$${n.toFixed(2)}`;
}

function parsePrice(priceStr: string | null | undefined) {
    const n = Number(priceStr);
    return Number.isFinite(n) ? n : NaN;
}

function discounted(price: number, percent: number) {
    if (!Number.isFinite(price)) return NaN;
    return price * (1 - percent / 100);
}

function isUrgency(v: any): v is Urgency {
    return v === "none" || v === "low" || v === "medium" || v === "high";
}

function asObject(v: any) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

async function getShopId(admin: any) {
    const resp = await admin.graphql(`
    query GetShopId { shop { id } }
  `);
    const j = await resp.json();
    return j?.data?.shop?.id as string;
}

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

    if (!raw) return { defaultPercent: 10, overrides: {} as Record<string, number>, urgencies: {} as Record<string, Urgency> };

    try {
        const parsed = JSON.parse(raw);
        const defaultPercent = clampPercent(Number(parsed?.defaultPercent ?? 10));
        const overrides = (parsed?.overrides ?? {}) as Record<string, number>;
        const urgenciesRaw = asObject(parsed?.urgencies);

        // normalize override values
        const cleanOverrides: Record<string, number> = {};
        Object.keys(overrides).forEach((k) => {
            cleanOverrides[String(k)] = clampPercent(Number(overrides[k]));
        });

        // normalize urgencies
        const cleanUrgencies: Record<string, Urgency> = {};
        Object.keys(urgenciesRaw).forEach((k) => {
            const val = urgenciesRaw[k];
            if (isUrgency(val) && val !== "none") {
                cleanUrgencies[String(k)] = val;
            }
        });

        return { defaultPercent, overrides: cleanOverrides, urgencies: cleanUrgencies };
    } catch {
        return { defaultPercent: 10, overrides: {} as Record<string, number>, urgencies: {} as Record<string, Urgency> };
    }
}

async function metafieldsSetJson(admin: any, ownerId: string, key: string, valueJsonString: string) {
    const resp = await admin.graphql(
        `
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
    `,
        {
            variables: {
                metafields: [{ ownerId, namespace: NS, key, type: "json", value: valueJsonString }],
            },
        }
    );

    const j = await resp.json();
    const errs = j?.data?.metafieldsSet?.userErrors || [];
    if (errs.length) throw new Error(errs.map((e: any) => e.message).join(", "));
}

async function getSavedDiscountNodeId(admin: any) {
    const resp = await admin.graphql(`
    query GetDiscountNodeId {
      shop {
        metafield(namespace: "${NS}", key: "${DISCOUNT_NODE_ID_KEY}") { value }
      }
    }
  `);

    const j = await resp.json();
    const raw = j?.data?.shop?.metafield?.value;
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

async function findDiscountNodeIdByTitle(admin: any) {
    const resp = await admin.graphql(`
    query FindDiscountNode {
      discountNodes(first: 50, query: "title:Binga Upsell") {
        nodes { id }
      }
    }
  `);
    const j = await resp.json();
    return j?.data?.discountNodes?.nodes?.[0]?.id ?? null;
}

type ProductRow = {
    id: string; // numeric product id
    title: string;
    image: string | null;
    price: string | null; // first variant price
};

async function getProductsPage(admin: any, args: { query: string; after?: string | null; before?: string | null }) {
    const q = (args.query || "").trim();
    const after = args.after || null;
    const before = args.before || null;

    const variables: any = {
        first: before ? null : PAGE_SIZE,
        after: before ? null : after,
        last: before ? PAGE_SIZE : null,
        before: before ? before : null,
        query: `status:active published_status:published${q ? ` title:*${q}*` : ""}`,
    };

    const resp = await admin.graphql(
        `#graphql
    query Products($first: Int, $after: String, $last: Int, $before: String, $query: String!) {
      products(first: $first, after: $after, last: $last, before: $before, query: $query) {
        nodes {
          id
          title
          featuredImage { url }
          variants(first: 1) {
            nodes { price }
          }
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }`,
        { variables }
    );

    const j = await resp.json();
    const nodes = j?.data?.products?.nodes ?? [];
    const pageInfo = j?.data?.products?.pageInfo ?? {};

    const products: ProductRow[] = nodes.map((p: any) => ({
        id: gidToId(p.id),
        title: p.title,
        image: p?.featuredImage?.url ?? null,
        price: p?.variants?.nodes?.[0]?.price ?? null,
    }));

    return { products, pageInfo };
}

export async function loader({ request }: LoaderFunctionArgs) {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const search = url.searchParams.get("q") || "";
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");

    const cfg = await getShopConfig(admin);
    const page = await getProductsPage(admin, { query: search, after, before });

    return json({
        defaultPercent: cfg.defaultPercent,
        overrides: cfg.overrides,
        urgencies: cfg.urgencies, // ✅ NEW
        products: page.products,
        pageInfo: page.pageInfo,
        q: search,
    });
}

export async function action({ request }: ActionFunctionArgs) {
    const { admin } = await authenticate.admin(request);

    try {
        const form = await request.formData();

        const defaultPercent = clampPercent(Number(String(form.get("defaultPercent") ?? "10")));
        const overridesRaw = String(form.get("overridesJson") ?? "{}");
        const urgenciesRaw = String(form.get("urgenciesJson") ?? "{}"); // ✅ NEW

        let overrides = {} as Record<string, number>;
        try {
            const parsed = JSON.parse(overridesRaw);
            overrides = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            overrides = {};
        }

        let urgenciesIn = {} as Record<string, Urgency>;
        try {
            const parsed = JSON.parse(urgenciesRaw);
            urgenciesIn = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            urgenciesIn = {};
        }

        // Keep your existing override cleanup logic exactly:
        const cleanOverrides: Record<string, number> = {};
        Object.keys(overrides).forEach((k) => {
            const pid = String(k);
            const pct = clampPercent(Number(overrides[k]));
            if (pct === defaultPercent) return; // same as default => unnecessary
            cleanOverrides[pid] = pct; // keep 0 too (means no discount)
        });

        // ✅ Clean urgencies (store only non-"none" to keep metafield small)
        const cleanUrgencies: Record<string, Urgency> = {};
        Object.keys(asObject(urgenciesIn)).forEach((k) => {
            const pid = String(k);
            const val = (urgenciesIn as any)[k];
            if (isUrgency(val) && val !== "none") cleanUrgencies[pid] = val;
        });

        const shopId = await getShopId(admin);

        // ✅ Save config with urgencies included (backward compatible)
        const configJson = JSON.stringify({
            defaultPercent,
            overrides: cleanOverrides,
            urgencies: cleanUrgencies,
        });

        // 1) Save on SHOP (proxy reads this)
        await metafieldsSetJson(admin, shopId, SHOP_KEY, configJson);

        // 2) Save on DISCOUNT NODE (Function reads this)
        let discountNodeId = await getSavedDiscountNodeId(admin);

        if (!discountNodeId) {
            discountNodeId = await findDiscountNodeIdByTitle(admin);
            if (discountNodeId) {
                await metafieldsSetJson(admin, shopId, DISCOUNT_NODE_ID_KEY, JSON.stringify(discountNodeId));
            }
        }

        if (!discountNodeId) {
            return json(
                { ok: false, error: "Could not find discount node. Create your Automatic App Discount titled 'Binga Upsell' first." },
                { status: 400 }
            );
        }

        await metafieldsSetJson(admin, discountNodeId, DISCOUNT_KEY, configJson);

        return json({
            ok: true,
            defaultPercent,
            savedOverridesCount: Object.keys(cleanOverrides).length,
            savedUrgenciesCount: Object.keys(cleanUrgencies).length, // ✅ NEW (optional info)
        });
    } catch (e: any) {
        return json({ ok: false, error: e?.message || "Save failed" }, { status: 500 });
    }
}

export default function AppSettings() {
    const data = useLoaderData() as {
        defaultPercent: number;
        overrides: Record<string, number>;
        urgencies: Record<string, Urgency>; // ✅ NEW
        products: ProductRow[];
        pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            startCursor: string | null;
            endCursor: string | null;
        };
        q: string;
    };

    const actionData = useActionData() as any;
    const nav = useNavigation();
    const saving = nav.state === "submitting";

    // Local controlled state
    const [defaultValue, setDefaultValue] = useState<string>("");
    const [searchValue, setSearchValue] = useState<string>("");

    // Your existing overrides state (unchanged)
    const [overrides, setOverrides] = useState<Record<string, number>>({});

    // ✅ NEW: urgencies state
    const [urgencies, setUrgencies] = useState<Record<string, Urgency>>({});

    useEffect(() => {
        setDefaultValue(String(data?.defaultPercent ?? 10));
        setSearchValue(data?.q ?? "");
        setOverrides(data?.overrides ?? {});
        setUrgencies(data?.urgencies ?? {}); // ✅ NEW
    }, [data?.defaultPercent, data?.q, data?.overrides, data?.urgencies]);

    const defaultPercent = clampPercent(Number(defaultValue || 0));

    const urgencyOptions = useMemo(
        () => [
            { label: "Not urgent", value: "none" },
            { label: "Low urgency", value: "low" },
            { label: "Medium urgency", value: "medium" },
            { label: "High urgency", value: "high" },
        ],
        []
    );

    const rows = useMemo(() => {
        return (data.products || []).map((p) => {
            const base = parsePrice(p.price);
            const override = overrides[String(p.id)];
            const pct = override !== undefined ? clampPercent(Number(override)) : defaultPercent;
            const after = discounted(base, pct);

            return {
                product: p,
                base,
                pct,
                after,
                hasOverride: override !== undefined,
                urgency: urgencies[String(p.id)] ?? "none", // ✅ NEW
            };
        });
    }, [data.products, overrides, defaultPercent, urgencies]);

    const buildUrl = (params: Record<string, string | null | undefined>) => {
        const u = new URL(window.location.href);
        Object.keys(params).forEach((k) => {
            const v = params[k];
            if (!v) u.searchParams.delete(k);
            else u.searchParams.set(k, v);
        });
        return u.pathname + "?" + u.searchParams.toString();
    };

    return (
        <Page title="Binga Upsell Settings">
            <Layout>
                <Layout.Section>
                    {actionData?.ok === false && (
                        <Banner tone="critical" title="Couldn't save settings">
                            <p>{actionData?.error}</p>
                        </Banner>
                    )}

                    {actionData?.ok === true && (
                        <Banner tone="success" title="Saved">
                            <p>
                                Default discount is now {actionData.defaultPercent}%. Saved overrides: {actionData.savedOverridesCount}.
                                {" "}
                                {typeof actionData.savedUrgenciesCount === "number"
                                    ? `Saved urgencies: ${actionData.savedUrgenciesCount}.`
                                    : null}
                            </p>
                        </Banner>
                    )}

                    <Card padding="400">
                        <Form method="post">
                            <InlineStack gap="400" align="space-between" blockAlign="center">
                                <Box width="260px">
                                    <TextField
                                        label="Default upsell discount (%)"
                                        name="defaultPercent"
                                        type="number"
                                        value={defaultValue}
                                        onChange={(v) => setDefaultValue(v)}
                                        autoComplete="off"
                                        min={0}
                                        max={90}
                                        helpText="Fallback for products without a per-product override."
                                    />
                                </Box>

                                <Box width="380px">
                                    <TextField
                                        label="Search products"
                                        value={searchValue}
                                        onChange={(v) => setSearchValue(v)}
                                        autoComplete="off"
                                        helpText="Search by product title."
                                    />
                                    <div style={{ marginTop: 8 }}>
                                        <InlineStack gap="200">
                                            <Button
                                                variant="secondary"
                                                url={buildUrl({ q: searchValue || null, after: null, before: null })}
                                                as={Link}
                                            >
                                                Search
                                            </Button>
                                            <Button variant="tertiary" url={buildUrl({ q: null, after: null, before: null })} as={Link}>
                                                Clear
                                            </Button>
                                        </InlineStack>
                                    </div>
                                </Box>

                                <div style={{ marginTop: 22 }}>
                                    <Button submit variant="primary" loading={saving}>
                                        Save
                                    </Button>
                                </div>
                            </InlineStack>

                            {/* Your existing overrides payload */}
                            <input type="hidden" name="overridesJson" value={JSON.stringify(overrides)} />

                            {/* ✅ NEW: urgencies payload */}
                            <input type="hidden" name="urgenciesJson" value={JSON.stringify(urgencies)} />

                            <div style={{ marginTop: 18 }}>
                                <IndexTable
                                    resourceName={{ singular: "product", plural: "products" }}
                                    itemCount={rows.length}
                                    selectable={false}
                                    headings={[
                                        { title: "Product" },
                                        { title: "Price" },
                                        { title: "Discount (%)" },
                                        { title: "After discount" },
                                        { title: "Override" },
                                        { title: "Urgency to sell" }, // ✅ NEW COLUMN
                                    ]}
                                >
                                    {rows.map((r, idx) => {
                                        const pid = String(r.product.id);
                                        const currentOverride = overrides[pid];

                                        return (
                                            <IndexTable.Row id={pid} key={pid} position={idx}>
                                                <IndexTable.Cell>
                                                    <InlineStack gap="300" blockAlign="center">
                                                        <Thumbnail source={r.product.image || ""} alt={r.product.title} size="small" />
                                                        <div>
                                                            <Text as="p" fontWeight="semibold">
                                                                {r.product.title}
                                                            </Text>
                                                            <Text as="p" tone="subdued">
                                                                ID: {pid}
                                                            </Text>
                                                        </div>
                                                    </InlineStack>
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>{money(r.base)}</IndexTable.Cell>

                                                {/* ✅ Your existing override edit behavior (unchanged) */}
                                                <IndexTable.Cell>
                                                    <TextField
                                                        labelHidden
                                                        label="Discount (%)"
                                                        type="number"
                                                        autoComplete="off"
                                                        value={String(currentOverride !== undefined ? currentOverride : r.pct)}
                                                        onChange={(v) => {
                                                            const next = clampPercent(Number(v || 0));
                                                            setOverrides((prev) => ({ ...prev, [pid]: next }));
                                                        }}
                                                        min={0}
                                                        max={90}
                                                    />
                                                </IndexTable.Cell>

                                                <IndexTable.Cell>{money(r.after)}</IndexTable.Cell>

                                                {/* ✅ Your existing buttons (unchanged) */}
                                                <IndexTable.Cell>
                                                    <InlineStack gap="200">
                                                        <Button
                                                            size="micro"
                                                            variant="tertiary"
                                                            onClick={() => {
                                                                setOverrides((prev) => {
                                                                    const copy = { ...prev };
                                                                    delete copy[pid];
                                                                    return copy;
                                                                });
                                                            }}
                                                        >
                                                            Use default
                                                        </Button>

                                                        <Button
                                                            size="micro"
                                                            variant="secondary"
                                                            onClick={() => {
                                                                setOverrides((prev) => ({ ...prev, [pid]: 0 }));
                                                            }}
                                                        >
                                                            No discount
                                                        </Button>
                                                    </InlineStack>
                                                </IndexTable.Cell>

                                                {/* ✅ NEW: urgency dropdown per product */}
                                                <IndexTable.Cell>
                                                    <Select
                                                        labelHidden
                                                        label="Urgency"
                                                        options={urgencyOptions}
                                                        value={urgencies[pid] ?? "none"}
                                                        onChange={(val) => {
                                                            const next = isUrgency(val) ? (val as Urgency) : "none";
                                                            setUrgencies((prev) => {
                                                                const copy = { ...prev };

                                                                // keep JSON small: remove if "none"
                                                                if (next === "none") {
                                                                    delete copy[pid];
                                                                } else {
                                                                    copy[pid] = next;
                                                                }
                                                                return copy;
                                                            });
                                                        }}
                                                    />
                                                </IndexTable.Cell>
                                            </IndexTable.Row>
                                        );
                                    })}
                                </IndexTable>

                                <div style={{ marginTop: 16 }}>
                                    <InlineStack align="space-between" blockAlign="center">
                                        <Text as="p" tone="subdued">
                                            Showing {rows.length} products per page (max {PAGE_SIZE}). Save your changes before switching pages.
                                        </Text>

                                        <Pagination
                                            hasPrevious={!!data.pageInfo?.hasPreviousPage}
                                            onPrevious={() => { }}
                                            previousURL={
                                                data.pageInfo?.hasPreviousPage
                                                    ? buildUrl({ before: data.pageInfo.startCursor, after: null })
                                                    : undefined
                                            }
                                            hasNext={!!data.pageInfo?.hasNextPage}
                                            onNext={() => { }}
                                            nextURL={
                                                data.pageInfo?.hasNextPage
                                                    ? buildUrl({ after: data.pageInfo.endCursor, before: null })
                                                    : undefined
                                            }
                                        />
                                    </InlineStack>
                                </div>
                            </div>
                        </Form>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
