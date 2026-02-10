import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";

import {
    Page,
    Layout,
    Card,
    Text,
    InlineStack,
    BlockStack,
    Button,
    Banner,
    Box,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";

const UPSALE_MARKER_KEY = "_binga_upsell";
const UPSALE_MARKER_VALUE = "1";

// NEW: order-level session marker (set from frontend flow before checkout)
const BINGA_SESSION_KEY = "_binga_session";
const BINGA_SESSION_VALUE = "1";

const MAX_ORDERS = 1000; // safety guard for MVP

type RangeKey = "7d" | "30d" | "90d";

type LoaderSuccess = {
    ok: true;
    range: RangeKey;
    currency: string;
    totalSales: number; // Binga-session qualified total sales
    bingaSales: number; // Binga upsell-attributed sales (subset of totalSales)
    totalOrders: number; // Binga-session qualified total orders
    bingaOrders: number; // Orders containing at least one Binga upsell line
    fetchedOrders: number;
    since: string;
};

type LoaderFailure = {
    ok: false;
    range: RangeKey;
    error: string;
};

type LoaderData = LoaderSuccess | LoaderFailure;

function json<T>(data: T, init?: ResponseInit) {
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

function toYYYYMMDD(d: Date) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function money(amount: number, currency: string) {
    if (!Number.isFinite(amount)) return "—";
    return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
    }).format(amount);
}

function intFmt(n: number) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        Number.isFinite(n) ? n : 0
    );
}

function normalizeRange(raw: string | null): RangeKey {
    if (raw === "7d" || raw === "30d" || raw === "90d") return raw;
    return "30d";
}

async function fetchOrdersAndCompute(admin: any, sinceYYYYMMDD: string) {
    let cursor: string | null = null;
    let hasNextPage = true;

    let totalSales = 0;
    let bingaSales = 0;
    let totalOrders = 0;
    let bingaOrders = 0;
    let currency = "USD";

    const queryStr = `status:any financial_status:paid created_at:>=${sinceYYYYMMDD}`;
    let seen = 0;

    while (hasNextPage && seen < MAX_ORDERS) {
        const resp = await admin.graphql(
            `#graphql
      query Orders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            currentSubtotalPriceSet { shopMoney { amount currencyCode } }
            customAttributes { key value }
            lineItems(first: 250) {
              nodes {
                discountedTotalSet { shopMoney { amount currencyCode } }
                originalTotalSet { shopMoney { amount currencyCode } }
                customAttributes { key value }
              }
            }
          }
        }
      }`,
            {
                variables: {
                    first: 100,
                    after: cursor,
                    query: queryStr,
                },
            }
        );

        const j = await resp.json();

        // Shopify may return HTTP 200 with GraphQL errors
        if (Array.isArray(j?.errors) && j.errors.length > 0) {
            const firstMsg =
                j.errors?.[0]?.message || "GraphQL query failed while loading orders.";
            throw new Error(firstMsg);
        }

        const orders = j?.data?.orders?.nodes ?? [];
        const pageInfo = j?.data?.orders?.pageInfo ?? {};

        for (const o of orders) {
            seen++;

            const sub = Number(o?.currentSubtotalPriceSet?.shopMoney?.amount ?? 0);
            const cur = String(
                o?.currentSubtotalPriceSet?.shopMoney?.currencyCode ?? "USD"
            );
            currency = cur || currency;

            const orderAttrs = o?.customAttributes ?? [];
            const hasBingaSession = Array.isArray(orderAttrs)
                ? orderAttrs.some(
                    (a: any) =>
                        a?.key === BINGA_SESSION_KEY &&
                        String(a?.value) === BINGA_SESSION_VALUE
                )
                : false;

            // IMPORTANT: only count orders touched by Binga session
            if (!hasBingaSession) continue;

            totalOrders += 1;
            totalSales += sub;

            let orderHasBingaUpsell = false;
            let orderBingaSales = 0;

            const lineItems = o?.lineItems?.nodes ?? [];
            for (const li of lineItems) {
                const attrs = li?.customAttributes ?? [];
                const isBingaUpsell = Array.isArray(attrs)
                    ? attrs.some(
                        (a: any) =>
                            a?.key === UPSALE_MARKER_KEY &&
                            String(a?.value) === UPSALE_MARKER_VALUE
                    )
                    : false;

                if (!isBingaUpsell) continue;

                orderHasBingaUpsell = true;

                const disc = Number(li?.discountedTotalSet?.shopMoney?.amount ?? NaN);
                const orig = Number(li?.originalTotalSet?.shopMoney?.amount ?? 0);
                const lineRevenue = Number.isFinite(disc) ? disc : orig;

                orderBingaSales += lineRevenue;
            }

            if (orderHasBingaUpsell) {
                bingaOrders += 1;
                bingaSales += orderBingaSales;
            }
        }

        hasNextPage = !!pageInfo?.hasNextPage;
        cursor = pageInfo?.endCursor ?? null;

        if (!orders.length) break;
    }

    return {
        currency,
        totalSales,
        bingaSales,
        totalOrders,
        bingaOrders,
        fetchedOrders: seen,
        since: sinceYYYYMMDD,
    };
}

export async function loader({ request }: LoaderFunctionArgs) {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const range = normalizeRange(url.searchParams.get("range"));

    const now = new Date();
    const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const sinceYYYYMMDD = toYYYYMMDD(since);

    try {
        const result = await fetchOrdersAndCompute(admin, sinceYYYYMMDD);

        return json<LoaderSuccess>({
            ok: true,
            range,
            ...result,
        });
    } catch (e: any) {
        return json<LoaderFailure>({
            ok: false,
            range,
            error:
                e?.message || "Failed to load analytics. Please try again in a moment.",
        });
    }
}

function StackedContributionBar({
    title,
    unitLabel,
    withoutLabel,
    contributedLabel,
    totalLabel,
    withoutValue,
    contributedValue,
    totalValue,
    formatter,
}: {
    title: string;
    unitLabel: string;
    withoutLabel: string;
    contributedLabel: string;
    totalLabel: string;
    withoutValue: number;
    contributedValue: number;
    totalValue: number;
    formatter: (v: number) => string;
}) {
    const total = Math.max(0, totalValue);
    const without = Math.max(0, withoutValue);
    const contrib = Math.max(0, contributedValue);

    const withoutPct = total > 0 ? (without / total) * 100 : 0;
    const contribPct = total > 0 ? (contrib / total) * 100 : 0;

    return (
        <Card padding="400">
            <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                        {title}
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                        Unit: {unitLabel}
                    </Text>
                </InlineStack>

                <div
                    style={{
                        border: "1px solid var(--p-color-border-secondary)",
                        borderRadius: 12,
                        padding: 14,
                    }}
                >
                    <div
                        style={{
                            width: "100%",
                            height: 28,
                            borderRadius: 999,
                            overflow: "hidden",
                            display: "flex",
                            background: "var(--p-color-bg-fill-tertiary)",
                        }}
                        aria-label={`${title} stacked bar`}
                    >
                        <div
                            style={{
                                width: `${withoutPct}%`,
                                background: "var(--p-color-bg-fill-tertiary)",
                                borderRight:
                                    contribPct > 0
                                        ? "1px solid var(--p-color-border-secondary)"
                                        : "none",
                            }}
                            title={`${withoutLabel}: ${formatter(without)} (${withoutPct.toFixed(
                                1
                            )}%)`}
                        />
                        <div
                            style={{
                                width: `${contribPct}%`,
                                background: "var(--p-color-bg-fill-brand)",
                            }}
                            title={`${contributedLabel}: ${formatter(contrib)} (${contribPct.toFixed(
                                1
                            )}%)`}
                        />
                    </div>

                    <div style={{ marginTop: 12 }}>
                        <InlineStack gap="400" wrap>
                            <InlineStack gap="150" blockAlign="center">
                                <div
                                    style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: 2,
                                        background: "var(--p-color-bg-fill-tertiary)",
                                        border: "1px solid var(--p-color-border-secondary)",
                                    }}
                                />
                                <Text as="span" variant="bodySm">
                                    {withoutLabel}: <strong>{formatter(without)}</strong>
                                </Text>
                            </InlineStack>

                            <InlineStack gap="150" blockAlign="center">
                                <div
                                    style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: 2,
                                        background: "var(--p-color-bg-fill-brand)",
                                    }}
                                />
                                <Text as="span" variant="bodySm">
                                    {contributedLabel}: <strong>{formatter(contrib)}</strong>
                                </Text>
                            </InlineStack>

                            <InlineStack gap="150" blockAlign="center">
                                <div
                                    style={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: 2,
                                        background: "var(--p-color-bg-fill-success)",
                                    }}
                                />
                                <Text as="span" variant="bodySm">
                                    {totalLabel}: <strong>{formatter(total)}</strong>
                                </Text>
                            </InlineStack>
                        </InlineStack>
                    </div>
                </div>
            </BlockStack>
        </Card>
    );
}

export default function AppAnalytics() {
    const data = useLoaderData() as LoaderData;
    const location = useLocation();
    const navigate = useNavigate();

    const rangeOptions: { label: string; value: RangeKey }[] = [
        { label: "Last 7 days", value: "7d" },
        { label: "Last 30 days", value: "30d" },
        { label: "Last 90 days", value: "90d" },
    ];

    const buildUrl = (range: RangeKey) => {
        const params = new URLSearchParams(location.search);
        params.set("range", range);
        const qs = params.toString();
        return qs ? `${location.pathname}?${qs}` : location.pathname;
    };

    if (!data.ok) {
        return (
            <Page title="Binga Impact (Extra Sales)">
                <Layout>
                    <Layout.Section>
                        <Banner tone="critical" title="Could not load analytics">
                            <p>{data.error}</p>
                        </Banner>
                    </Layout.Section>
                </Layout>
            </Page>
        );
    }

    // Safety clamp (in case of legacy/dirty data)
    const safeBingaSales = Math.min(Math.max(0, data.bingaSales), Math.max(0, data.totalSales));
    const safeBingaOrders = Math.min(Math.max(0, data.bingaOrders), Math.max(0, data.totalOrders));

    const baselineSales = Math.max(0, data.totalSales - safeBingaSales);
    const baselineOrders = Math.max(0, data.totalOrders - safeBingaOrders);

    const salesShare = data.totalSales > 0 ? (safeBingaSales / data.totalSales) * 100 : 0;
    const orderShare = data.totalOrders > 0 ? (safeBingaOrders / data.totalOrders) * 100 : 0;

    // AOV composition (always non-negative + additive)
    const totalAov = data.totalOrders > 0 ? data.totalSales / data.totalOrders : 0;
    const withoutBingaAov = data.totalOrders > 0 ? baselineSales / data.totalOrders : 0;
    const bingaAovContribution = Math.max(0, totalAov - withoutBingaAov);
    const bingaAovShare = totalAov > 0 ? (bingaAovContribution / totalAov) * 100 : 0;

    return (
        <Page title="Binga Impact (Extra Sales)">
            <Layout>
                <Layout.Section>
                    <Card padding="400">
                        <InlineStack align="space-between" blockAlign="center">
                            <InlineStack gap="200">
                                {rangeOptions.map((o) => (
                                    <Button
                                        key={o.value}
                                        size="micro"
                                        variant={o.value === data.range ? "primary" : "secondary"}
                                        onClick={() => navigate(buildUrl(o.value))}
                                    >
                                        {o.label}
                                    </Button>
                                ))}
                            </InlineStack>

                            <Text as="p" tone="subdued">
                                Since <strong>{data.since}</strong> (fetched {data.fetchedOrders} paid orders)
                            </Text>
                        </InlineStack>
                    </Card>
                </Layout.Section>

                <Layout.Section>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                            gap: 16,
                        }}
                    >
                        <Card padding="400">
                            <BlockStack gap="200">
                                <Text as="p" tone="subdued" variant="headingMd">
                                    Total sales (Binga-active checkouts)
                                </Text>
                                <Text as="h2" variant="headingLg">
                                    {money(data.totalSales, data.currency)}
                                </Text>
                            </BlockStack>
                        </Card>

                        <Card padding="400">
                            <BlockStack gap="200">
                                <Text as="p" tone="subdued" variant="headingMd">
                                    Binga-attributed added sales
                                </Text>
                                <Text as="h2" variant="headingLg">
                                    {money(safeBingaSales, data.currency)}
                                </Text>
                                <Text as="p" tone="subdued" variant="bodyMd">
                                    Share: {salesShare.toFixed(1)}%
                                </Text>
                            </BlockStack>
                        </Card>

                        <Card padding="400">
                            <BlockStack gap="200">
                                <Text as="p" tone="subdued" variant="headingMd">
                                    AOV (composition)
                                </Text>
                                <Text as="h2" variant="headingLg">
                                    {money(totalAov, data.currency)}
                                </Text>
                                <Text as="p" tone="subdued" variant="bodyMd">
                                    {money(withoutBingaAov, data.currency)} +{" "}
                                    <span style={{ color: "var(--p-color-text-success)" }}>
                                        {money(bingaAovContribution, data.currency)}
                                    </span>{" "}
                                    = {money(totalAov, data.currency)}
                                </Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                    Binga contribution: {bingaAovShare.toFixed(1)}% of total AOV
                                </Text>
                            </BlockStack>
                        </Card>
                    </div>
                </Layout.Section>

                <Layout.Section>
                    <Banner title={`Binga-attributed sales: ${money(data.bingaSales, data.currency)}
                            from ${intFmt(data.bingaOrders)} orders (
                            ${orderShare.toFixed(1)}% of paid orders)`} tone="success">

                    </Banner>
                </Layout.Section>

                <Layout.Section>
                    <BlockStack gap="400">
                        <StackedContributionBar
                            title="Sales Contribution"
                            unitLabel={data.currency}
                            withoutLabel="Without Binga"
                            contributedLabel="Binga contribution"
                            totalLabel="Total sales"
                            withoutValue={baselineSales}
                            contributedValue={safeBingaSales}
                            totalValue={data.totalSales}
                            formatter={(v) => money(v, data.currency)}
                        />

                        <StackedContributionBar
                            title="Orders Contribution"
                            unitLabel="orders"
                            withoutLabel="Without Binga"
                            contributedLabel="Binga contribution"
                            totalLabel="Total orders"
                            withoutValue={baselineOrders}
                            contributedValue={safeBingaOrders}
                            totalValue={data.totalOrders}
                            formatter={(v) => intFmt(v)}
                        />

                        <StackedContributionBar
                            title="AOV Contribution"
                            unitLabel={data.currency}
                            withoutLabel="Without Binga AOV"
                            contributedLabel="Binga AOV contribution"
                            totalLabel="Total AOV"
                            withoutValue={withoutBingaAov}
                            contributedValue={bingaAovContribution}
                            totalValue={totalAov}
                            formatter={(v) => money(v, data.currency)}
                        />
                    </BlockStack>
                </Layout.Section>

                <Layout.Section>
                    <Box paddingBlockStart="200">
                        <Text as="p" tone="subdued" variant="bodySm">
                            Note: This dashboard includes only paid orders marked with{" "}
                            <code>{BINGA_SESSION_KEY}=1</code>. Upsell contribution comes from line items marked{" "}
                            <code>{UPSALE_MARKER_KEY}=1</code>.
                        </Text>
                    </Box>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
