import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";

import { Page, Layout, Card, TextField, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

const NS = "$app:binga";
const SHOP_KEY = "upsell_discount_config";
const DISCOUNT_KEY = "upsell_discount_config";
const DISCOUNT_NODE_ID_KEY = "upsell_discount_discountNodeId";

function json(data: any, init?: ResponseInit) {
    return new Response(JSON.stringify(data), {
        ...init,
        headers: {
            "Content-Type": "application/json", Pragma: "no-cache",
            ...(init?.headers || {})
        },
    });
}

function clampPercent(n: number) {
    if (!Number.isFinite(n)) return 10;
    return Math.max(0, Math.min(90, Math.round(n)));
}

async function getShopId(admin: any) {
    const resp = await admin.graphql(`
    query GetShopId {
      shop { id }
    }
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

    if (!raw) return { defaultPercent: 10, overrides: {} };

    try {
        const parsed = JSON.parse(raw);
        return {
            defaultPercent: clampPercent(Number(parsed?.defaultPercent ?? 10)),
            overrides: parsed?.overrides ?? {},
        };
    } catch {
        return { defaultPercent: 10, overrides: {} };
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
                metafields: [
                    { ownerId, namespace: NS, key, type: "json", value: valueJsonString },
                ],
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

    // we stored it as JSON string, so parse if possible
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

export async function loader({ request }: LoaderFunctionArgs) {
    const { admin } = await authenticate.admin(request);
    const cfg = await getShopConfig(admin);
    return json({ defaultPercent: cfg.defaultPercent });
}

export async function action({ request }: ActionFunctionArgs) {
    const { admin } = await authenticate.admin(request);

    try {
        const form = await request.formData();
        const raw = String(form.get("defaultPercent") ?? "");
        const percent = clampPercent(Number(raw));

        const shopId = await getShopId(admin);

        const configJson = JSON.stringify({ defaultPercent: percent, overrides: {} });

        // 1) Save on SHOP (popup reads this)
        await metafieldsSetJson(admin, shopId, SHOP_KEY, configJson);

        // 2) Save on DISCOUNT NODE (Function reads this)
        let discountNodeId = await getSavedDiscountNodeId(admin);

        if (!discountNodeId) {
            discountNodeId = await findDiscountNodeIdByTitle(admin);
            if (discountNodeId) {
                // Store the discount node id on shop so we don't search every time
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

        return json({ ok: true, defaultPercent: percent });
    } catch (e: any) {
        return json({ ok: false, error: e?.message || "Save failed" }, { status: 500 });
    }
}

export default function AppSettings() {
    const data = useLoaderData() as { defaultPercent: number };
    const actionData = useActionData() as any;
    const nav = useNavigation();
    const saving = nav.state === "submitting";

    // ✅ Polaris TextField must be controlled
    const [value, setValue] = useState<string>("");

    useEffect(() => {
        setValue(String(data?.defaultPercent ?? 10));
    }, [data?.defaultPercent]);

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
                            <p>Discount updated to {actionData.defaultPercent}%.</p>
                        </Banner>
                    )}

                    <Card padding="400">
                        <Form method="post">
                            <TextField
                                label="Upsell discount percentage"
                                name="defaultPercent"
                                type="number"
                                autoComplete="off"
                                value={value}
                                onChange={(v) => setValue(v)}
                                helpText="Applied only to items added from the popup (marked lines)."
                                min={0}
                                max={90}
                            />

                            <div style={{ marginTop: 12 }}>
                                <Button submit variant="primary" loading={saving}>
                                    Save
                                </Button>
                            </div>
                        </Form>
                    </Card>
                </Layout.Section>
            </Layout>
        </Page>
    );
}
