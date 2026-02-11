(function () {
    const DEBUG = true;
    const log = (...a) => DEBUG && console.log("[BINGA]", ...a);

    // Never run inside checkout
    if (location.pathname.startsWith("/checkout")) return;

    const BUY_NOW_SELECTORS = [
        ".shopify-payment-button__button",
        ".shopify-payment-button button",
        ".shopify-payment-button [type='submit']",
        "button[name='buy_now']",
        "[data-testid='Checkout-button']"
    ].join(",");

    const CHECKOUT_SELECTORS = [
        "button[name='checkout']",
        "form[action^='/cart'] button[type='submit'][name='checkout']",
        "a[href^='/checkout']",
        "button[href^='/checkout']"
    ].join(",");

    // Marker for Shopify Function (only for upsell items)
    const UPSALE_MARKER_KEY = "_binga_upsell";
    const UPSALE_MARKER_VALUE = "1";

    // NEW: pass per-line discount percent (Function may use this)
    const UPSALE_PCT_KEY = "_binga_pct"; // string percent, e.g. "10"

    // NEW: Order/cart-level session marker for analytics gating
    const BINGA_SESSION_KEY = "_binga_session";
    const BINGA_SESSION_VALUE = "1";

    // -------------------------
    // Recently viewed tracking (localStorage)
    // -------------------------
    const BINGA_VIEW_KEY = "__binga_viewed_products_v1__";
    const BINGA_VIEW_MAX_STORE = 60; // keep at most 60 products in storage
    const BINGA_VIEW_MAX_SEND = 25; // send at most 25 to proxy (keep URL small)

    function safeJsonParse(str, fallback) {
        try {
            return JSON.parse(str);
        } catch {
            return fallback;
        }
    }

    function loadViewedMap() {
        const raw = localStorage.getItem(BINGA_VIEW_KEY);
        const data = safeJsonParse(raw, {});
        return data && typeof data === "object" ? data : {};
    }

    function saveViewedMap(map) {
        try {
            localStorage.setItem(BINGA_VIEW_KEY, JSON.stringify(map));
        } catch { }
    }

    function recordProductView(productId) {
        const pid = String(productId || "").trim();
        if (!pid) return;

        const now = Date.now();
        const map = loadViewedMap();

        const prev = map[pid] || {};
        const nextCount = Math.min(999, Number(prev.c || 0) + 1);

        map[pid] = { c: nextCount, t: now };

        // prune oldest if too many
        const entries = Object.entries(map);
        if (entries.length > BINGA_VIEW_MAX_STORE) {
            entries.sort((a, b) => Number(a[1]?.t || 0) - Number(b[1]?.t || 0)); // oldest first
            const toRemove = entries.length - BINGA_VIEW_MAX_STORE;
            for (let i = 0; i < toRemove; i++) delete map[entries[i][0]];
        }

        saveViewedMap(map);
    }

    function buildViewedParam(maxSend = BINGA_VIEW_MAX_SEND) {
        const map = loadViewedMap();
        const entries = Object.entries(map)
            .map(([id, v]) => ({
                id: String(id),
                c: Number(v?.c || 0),
                t: Number(v?.t || 0),
            }))
            .filter((x) => x.id && x.c > 0 && x.t > 0)
            .sort((a, b) => b.t - a.t) // most recent first
            .slice(0, maxSend);

        // format: "id:count:timestamp|id:count:timestamp"
        return entries.map((x) => `${x.id}:${x.c}:${x.t}`).join("|");
    }

    // record current product view (only works where productId is available)
    if (window.BINGA_BUY_NOW?.productId) {
        recordProductView(window.BINGA_BUY_NOW.productId);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Prevent double-running if user clicks twice quickly
    let FLOW_ACTIVE = false;

    function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity || 1) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function firstVisible(root, selector) {
        const list = Array.from((root || document).querySelectorAll(selector));
        return list.find(isVisible) || null;
    }

    function unlockScrollAndInert() {
        document.documentElement.classList.remove("overflow-hidden", "no-scroll", "lock-scroll");
        document.body.classList.remove("overflow-hidden", "no-scroll", "lock-scroll");
        document.body.style.removeProperty("overflow");

        document.querySelector("#MainContent")?.removeAttribute("inert");
        document.querySelector("main")?.removeAttribute("inert");
    }

    function findCartDrawerCandidates() {
        const c = [];
        // Dialog-based drawers
        c.push(...Array.from(document.querySelectorAll("dialog[open]")));
        c.push(document.querySelector("dialog#CartDrawer"));
        c.push(document.querySelector("dialog[id*='CartDrawer']"));
        c.push(document.querySelector("dialog[id*='cart']"));
        c.push(document.querySelector("dialog[class*='cart']"));

        // Dawn / OS2
        c.push(document.querySelector("cart-drawer"));
        c.push(document.querySelector("#CartDrawer"));
        c.push(document.querySelector("[id*='CartDrawer']"));
        c.push(document.querySelector(".cart-drawer"));
        c.push(document.querySelector(".drawer"));

        return c.filter(Boolean);
    }

    function pickOpenCartDrawer() {
        const candidates = findCartDrawerCandidates();
        let best = candidates.find(isVisible) || null;

        if (!best) {
            best =
                candidates.find((el) => {
                    const id = (el.id || "").toLowerCase();
                    const cls = (el.className || "").toString().toLowerCase();
                    return id.includes("cart") || cls.includes("cart");
                }) || null;
        }
        return best;
    }

    // Force-hide state while modal is open (so drawer can’t overlap)
    let forcedHidden = null;

    function forceHideElement(el) {
        if (!el) return null;
        const prev = el.getAttribute("style") || "";
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        el.style.setProperty("display", "none", "important");
        return { el, prev };
    }

    function forceHideOverlays() {
        const overlays = [
            "#CartDrawer-Overlay",
            ".drawer-overlay",
            ".drawer__overlay",
            ".cart-drawer__overlay",
            ".modal__overlay",
            ".overlay",
        ];

        const saved = [];
        for (const sel of overlays) {
            const o = firstVisible(document, sel);
            if (o) {
                const s = forceHideElement(o);
                if (s) saved.push(s);
            }
        }
        return saved;
    }

    function restoreForcedHidden(state) {
        if (!state) return;
        try {
            if (state.drawer?.el) state.drawer.el.setAttribute("style", state.drawer.prev || "");
            (state.overlays || []).forEach((o) => {
                if (o?.el) o.el.setAttribute("style", o.prev || "");
            });
        } catch { }
    }

    function drawerStillVisible() {
        const root = pickOpenCartDrawer();
        return !!(root && isVisible(root));
    }

    async function closeCartDrawerHard() {
        const root = pickOpenCartDrawer();
        if (!root) {
            unlockScrollAndInert();
            return false;
        }

        // If root is dialog OR contains open dialog => close it
        const dialog =
            root.tagName === "DIALOG"
                ? root
                : root.querySelector?.("dialog[open]") || document.querySelector("dialog[open]#CartDrawer");

        try {
            if (dialog && typeof dialog.close === "function") {
                dialog.close();
                dialog.removeAttribute("open");
            }
        } catch { }

        // If root has a close method
        try {
            if (typeof root.close === "function") root.close();
        } catch { }

        // Click close button inside drawer
        const closeBtn =
            firstVisible(root, "button[aria-label*='Close']") ||
            firstVisible(root, "button[name='close']") ||
            firstVisible(root, "button.drawer__close") ||
            firstVisible(root, "button.cart-drawer__close") ||
            firstVisible(root, ".drawer__close") ||
            firstVisible(root, ".cart-drawer__close") ||
            null;

        if (closeBtn) {
            try {
                closeBtn.click();
            } catch { }
        }

        // Click overlay/backdrop if exists
        const overlay =
            firstVisible(document, "#CartDrawer-Overlay") ||
            firstVisible(document, ".drawer-overlay") ||
            firstVisible(document, ".drawer__overlay") ||
            firstVisible(document, ".cart-drawer__overlay");

        if (overlay) {
            try {
                overlay.click();
            } catch { }
        }

        await sleep(120);

        // Still visible? force-hide while our modal is open
        if (drawerStillVisible()) {
            const drawerSave = forceHideElement(root);
            const overlaysSave = forceHideOverlays();
            forcedHidden = { drawer: drawerSave, overlays: overlaysSave };
        }

        unlockScrollAndInert();
        return true;
    }

    async function getCart() {
        const res = await fetch("/cart.js", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("cart_fetch_failed");
        return res.json();
    }

    async function addVariantToCart(variantId, quantity) {
        const res = await fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ id: Number(variantId), quantity: Number(quantity || 1) })
        });
        if (!res.ok) throw new Error("add_to_cart_failed");
        return res.json();
    }

    async function markBingaSession() {
        // Merge existing cart attributes to avoid overwriting other attributes
        let attrs = { [BINGA_SESSION_KEY]: BINGA_SESSION_VALUE };

        try {
            const cart = await getCart();
            attrs = {
                ...(cart?.attributes || {}),
                [BINGA_SESSION_KEY]: BINGA_SESSION_VALUE,
            };
        } catch {
            // ignore cart fetch failure; fallback to single attribute
        }

        const res = await fetch("/cart/update.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ attributes: attrs }),
        });

        if (!res.ok) throw new Error("mark_binga_session_failed");
        return res.json();
    }

    // Best effort so UX isn't blocked on slow network
    async function markBingaSessionBestEffort(timeoutMs = 900) {
        try {
            await Promise.race([markBingaSession(), sleep(timeoutMs)]);
        } catch (e) {
            log("mark session failed:", e);
        }
    }

    async function changeLineQuantity(line, quantity) {
        const res = await fetch("/cart/change.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ line: Number(line), quantity: Number(quantity) }),
        });
        if (!res.ok) throw new Error("change_line_failed");
        return res.json();
    }

    function getVariantQtyFromCart(cart, variantId) {
        const id = Number(variantId);
        const item = (cart?.items || []).find((i) => Number(i.variant_id) === id);
        return item ? Number(item.quantity || 0) : 0;
    }

    function getLineIndexForVariant(cart, variantId) {
        const id = Number(variantId);
        const idx = (cart?.items || []).findIndex((i) => Number(i.variant_id) === id);
        return idx >= 0 ? idx + 1 : null; // 1-based
    }

    function getMainVariantAndQty(clickedEl) {
        let form = clickedEl.closest("form");
        if (!form) form = document.querySelector("form[action^='/cart/add']");
        const idInput = form?.querySelector("input[name='id']");
        const qtyInput = form?.querySelector("input[name='quantity']");
        const variantId = idInput?.value ? Number(idInput.value) : null;
        const qty = qtyInput?.value ? Number(qtyInput.value) : 1;
        return { variantId, qty };
    }

    function openModalSkeleton() {
        const overlay = document.createElement("div");
        overlay.id = "binga-buy-now-overlay";
        overlay.innerHTML = `
      <style>
        #binga-buy-now-overlay{ position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:999999; display:flex; align-items:center; justify-content:center; padding:16px; }
        #binga-buy-now-modal{ width:min(760px,100%); background:#fff; border-radius:14px; padding:24px; box-shadow:0 20px 60px rgba(0,0,0,.25); font-family:inherit; max-height:80vh; overflow-y:auto; }
        #binga-buy-now-modal h3{ margin:0 0 10px 0; font-size:18px; font-weight:600; }
        .binga-products{
        display:grid;
        grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));
        gap:16px;
        margin:20px 0;
        align-items:stretch;
        }

        .binga-product{
        border:1px solid #e0e0e0;
        border-radius:8px;
        padding:12px;
        text-align:center;
        transition:all 0.2s;

        display:flex;
        flex-direction:column;
        height:100%;
        }

        .binga-product img{
        width:100%;
        height:220px;
        object-fit:contain;
        border-radius:4px;
        margin-bottom:8px;
        }

        .binga-product-title{
        font-size:14px;
        font-weight:500;
        margin:8px 0;
        min-height:44px;
        display:-webkit-box;
        -webkit-line-clamp:2;
        -webkit-box-orient:vertical;
        overflow:hidden;
        }

        .binga-product-price{
        font-size:16px;
        font-weight:600;
        color:#333;
        margin-bottom:10px;
        }

        .binga-add{
        margin-top:auto;
        width:100%;
        }

        .binga-footer{ display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
        .binga-btn{ font-size:14px; padding:10px 20px; border-radius:6px; border:1px solid rgba(0,0,0,.14); background:#fff; cursor:pointer; }
        .binga-btn.primary{ background:#111; color:#fff; border-color:#111; }
        .binga-loading{ padding:40px; text-align:center; font-size:14px; color:#666; }
      </style>
      <div id="binga-buy-now-modal" role="dialog" aria-modal="true">
        <h3>Add one more item before checkout?</h3>
        <div class="binga-loading">Loading recommendations...</div>
        <div class="binga-footer">
          <button class="binga-btn" id="binga-skip">No thanks, checkout now</button>
        </div>
      </div>
    `;

        function close() { overlay.remove(); }

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });

        document.body.appendChild(overlay);
        return { close };
    }

    function renderProducts(products, onAdd, onSkip) {
        const container = document.querySelector("#binga-buy-now-modal");
        if (!container) return;

        const renderAddButton = (variantId) => `
      <button class="binga-btn primary binga-add" data-variant-id="${variantId}">
        Add to cart
      </button>
    `;

        const renderStepper = (variantId, qty) => `
      <div class="binga-stepper" data-variant-id="${variantId}">
        <button class="binga-btn binga-minus" data-variant-id="${variantId}" aria-label="Decrease">−</button>
        <div class="binga-qty" data-variant-id="${variantId}">${qty}</div>
        <button class="binga-btn binga-plus" data-variant-id="${variantId}" aria-label="Increase">+</button>
      </div>
    `;

        const setBusy = (variantId, busy) => {
            const action = container.querySelector(`.binga-action[data-variant-id="${variantId}"]`);
            if (!action) return;
            action.querySelectorAll("button").forEach((b) => (b.disabled = !!busy));
        };

        const setActionUI = (variantId, qty) => {
            const action = container.querySelector(`.binga-action[data-variant-id="${variantId}"]`);
            if (!action) return;
            action.innerHTML = qty > 0 ? renderStepper(variantId, qty) : renderAddButton(variantId);
            // NOTE: action dataset (including discount percent) stays intact
        };

        // ✅ Event delegation (bind once)
        if (!container.dataset.bingaBound) {
            container.dataset.bingaBound = "1";

            container.addEventListener("click", async (e) => {
                const skip = e.target.closest("#binga-skip, #binga-checkout-now");
                if (skip) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
                    onCheckoutNow();
                    return;
                }

                const addBtn = e.target.closest(".binga-add");
                if (addBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    const variantId = addBtn.dataset.variantId;
                    if (!variantId) return;

                    const actionWrap = addBtn.closest(".binga-action");
                    const pctFromDom = Number(actionWrap?.dataset?.discountPercent || "");
                    const pct = Number.isFinite(pctFromDom) && pctFromDom > 0 ? pctFromDom : Number(discountPercent || 0);

                    setBusy(variantId, true);
                    const prev = addBtn.textContent;
                    addBtn.textContent = "Adding...";

                    try {
                        const updatedCart = await onAddOnly(variantId, pct);
                        setCartCount(updatedCart);
                        const qty = getVariantQtyFromCart(updatedCart, variantId);
                        setActionUI(variantId, qty);
                    } catch (err) {
                        log("Add failed:", err);
                        addBtn.textContent = prev || "Add to cart";
                    } finally {
                        setBusy(variantId, false);
                    }
                    return;
                }

                const plusBtn = e.target.closest(".binga-plus");
                if (plusBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    const variantId = plusBtn.dataset.variantId;
                    if (!variantId) return;

                    setBusy(variantId, true);
                    try {
                        const cart = await getCart();
                        const line = getLineIndexForVariant(cart, variantId);
                        const currentQty = getVariantQtyFromCart(cart, variantId);
                        if (!line) throw new Error("line_not_found");

                        const updatedCart = await changeLineQuantity(line, currentQty + 1);
                        setCartCount(updatedCart);
                        setActionUI(variantId, currentQty + 1);
                    } catch (err) {
                        log("Plus failed:", err);
                    } finally {
                        setBusy(variantId, false);
                    }
                    return;
                }

                const minusBtn = e.target.closest(".binga-minus");
                if (minusBtn) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    const variantId = minusBtn.dataset.variantId;
                    if (!variantId) return;

                    setBusy(variantId, true);
                    try {
                        const cart = await getCart();
                        const line = getLineIndexForVariant(cart, variantId);
                        const currentQty = getVariantQtyFromCart(cart, variantId);
                        if (!line) throw new Error("line_not_found");

                        const nextQty = Math.max(0, currentQty - 1);
                        const updatedCart = await changeLineQuantity(line, nextQty);
                        setCartCount(updatedCart);
                        setActionUI(variantId, nextQty);
                    } catch (err) {
                        log("Minus failed:", err);
                    } finally {
                        setBusy(variantId, false);
                    }
                    return;
                }
            });
        }

        if (!products?.length) {
            container.innerHTML = `
      <h3>No recommendations available</h3>
      <div class="binga-footer">
        <button class="binga-btn primary" id="binga-checkout-now">Checkout now</button>
      </div>
    `;
            container.querySelector("#binga-checkout-now")?.addEventListener("click", onSkip);
            return;
        }

        const productsHTML = products
            .map(
                (p) => `
      <div class="binga-product">
        ${p.image ? `<img src="${p.image}" alt="${p.title}" />` : ""}
        <div class="binga-product-title">${p.title}</div>
        <div class="binga-product-price">$${p.price ?? ""}</div>

        <button class="binga-btn primary binga-add" data-variant-id="${p.variantId}">
          Add to cart
        </button>
      </div>
    `
            )
        return `
          <div class="binga-product">
            ${p.image ? `<img src="${p.image}" alt="${p.title}" />` : ""}
            <div class="binga-product-title">${p.title}</div>

            <div class="binga-product-price">
              <div class="orig">${original}</div>
              <div class="disc">${discounted}<span class="pct">(${pct}% off)</span></div>
            </div>

            <div class="binga-action" data-variant-id="${p.variantId}" data-discount-percent="${pct}">
              ${renderAddButton(p.variantId)}
            </div>
          </div>
        `;
    })
            .join("");

    container.innerHTML = `
    <h3>Add one more item before checkout?</h3>
    <div class="binga-products">${productsHTML}</div>
    <div class="binga-footer">
      <button class="binga-btn" id="binga-skip">No thanks, checkout now</button>
    </div>
  `;

    // "Add to cart" per item
    container.querySelectorAll(".binga-add").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

            const variantId = btn.dataset.variantId;
            if (!variantId) return;

            // Optional: simple loading state
            btn.disabled = true;
            btn.textContent = "Adding...";

            try {
                await onAdd(variantId);
                btn.textContent = "Added ✅";
            } catch (err) {
                console.log("[BINGA] Add failed:", err);
                btn.disabled = false;
                btn.textContent = "Add to cart";
            }
        });
    });

    container.querySelector("#binga-skip")?.addEventListener("click", onSkip);
}


    async function fetchRecommendations(excludeCsv) {
    const url = `/apps/binga-reco/recommend?limit=3&exclude=${encodeURIComponent(excludeCsv)}`;
    log("Fetching recommendations:", url);

    const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    const out = await res.json();
    log("Proxy response:", out);

    if (!out?.ok) return [];
    return out.products || [];
}

async function interceptFlow({ mode, clickedEl, event }) {
    // mode: "buy_now" (product page) OR "checkout" (cart/mini-cart)
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    log("Intercepted:", mode);

    const { close } = openModalSkeleton();
    // Close drawer before showing popup
    if (mode === "checkout") {
        await closeCartDrawerHard();
        setTimeout(() => closeCartDrawerHard().catch(() => { }), 250);
        await sleep(80);
    }

    // ✅ BUY NOW: add main product FIRST, do NOT redirect
    if (mode === "buy_now") {
        const { variantId, qty } = getMainVariantAndQty(clickedEl || event.target);
        if (!variantId) {
            FLOW_ACTIVE = false;
            location.href = "/checkout";
            return;
        }

        try {
            await addVariantToCart(variantId, qty); // main item, no marker
        } catch (e) {
            log("Main product add failed:", e);
            FLOW_ACTIVE = false;
            location.href = "/checkout";
            return;
        }
    }

    const { close } = openModalSkeleton(() => {
        FLOW_ACTIVE = false;
    });

    let cart;
    try {
        cart = await getCart();
    } catch (e) {
        log("Cart fetch failed:", e);
        close();
        if (mode === "buy_now") location.href = "/checkout";
        return;
    }

    const excludeFromCart = (cart.items || []).map(i => String(i.product_id));
    const currentProductId = window.BINGA_BUY_NOW?.productId ? String(window.BINGA_BUY_NOW.productId) : null;
    const exclude = [...excludeFromCart, currentProductId].filter(Boolean).join(",");

    let products = [];
    try {
        products = await fetchRecommendations(exclude);
    } catch (e) {
        log("Recommendation fetch failed:", e);
        close();
        if (mode === "buy_now") {
            const { variantId, qty } = getMainVariantAndQty(clickedEl);
            if (variantId) await addVariantToCart(variantId, qty);
        }
        location.href = "/checkout";
        return;
    }

    renderProducts(
        products,
        async (selectedVariantId) => {
            close();
            if (selectedVariantId) {
                try { await addVariantToCart(Number(selectedVariantId), 1); }
                catch (e) { log("Failed adding recommended:", e); }
            }
            discountPercent,

                // Add-only (no redirect) + marker for Function + percent hint
                async (selectedVariantId, pct) => {
                    const pctNum = Number(pct);
                    const pctToSend =
                        Number.isFinite(pctNum) && pctNum >= 0 ? String(Math.round(pctNum)) : String(Math.round(Number(discountPercent || 0)));

                    await addVariantToCart(Number(selectedVariantId), 1, {
                        [UPSALE_MARKER_KEY]: UPSALE_MARKER_VALUE,
                        [UPSALE_PCT_KEY]: pctToSend,
                    });
                    return await getCart();
                },

                if (mode === "buy_now") {
                const { variantId, qty } = getMainVariantAndQty(clickedEl);
                if (variantId) await addVariantToCart(variantId, qty);
            }

            location.href = "/checkout";
        },
        async () => {
            await markBingaSessionBestEffort();
            close();

            if (mode === "buy_now") {
                const { variantId, qty } = getMainVariantAndQty(clickedEl);
                if (variantId) await addVariantToCart(variantId, qty);
            }

            location.href = "/checkout";
        }
    );
}

// Capture phase so we beat theme handlers
document.addEventListener("click", (e) => {
    const buyNowBtn = e.target?.closest?.(BUY_NOW_SELECTORS);
    if (buyNowBtn) {
        interceptFlow({ mode: "buy_now", clickedEl: buyNowBtn, event: e }).catch(err => log("buy_now error:", err));
        return;
    }

    const checkoutEl = e.target?.closest?.(CHECKOUT_SELECTORS);
    if (checkoutEl) {
        interceptFlow({ mode: "checkout", clickedEl: checkoutEl, event: e }).catch(err => log("checkout error:", err));
    }
}, true);
const submitter = e.submitter || document.activeElement;
if (!submitter || !submitter.closest) return;

const buyNowBtn = submitter.closest(BUY_NOW_SELECTORS);
if (buyNowBtn) {
    interceptFlow({ mode: "buy_now", clickedEl: buyNowBtn, event: e }).catch((err) =>
        log("buy_now submit error:", err)
    );
    return;
}

const checkoutBtn = submitter.closest(CHECKOUT_SELECTORS);
if (checkoutBtn) {
    interceptFlow({ mode: "checkout", clickedEl: checkoutBtn, event: e }).catch((err) =>
        log("checkout submit error:", err)
    );
}
},
true
);

// ✅ Click capture fallback (works for drawer checkout links/buttons)
document.addEventListener(
    "click",
    (e) => {
        const buyNowBtn = e.target?.closest?.(BUY_NOW_SELECTORS);
        if (buyNowBtn) {
            interceptFlow({ mode: "buy_now", clickedEl: buyNowBtn, event: e }).catch((err) =>
                log("buy_now click error:", err)
            );
            return;
        }

        const checkoutEl = e.target?.closest?.(CHECKOUT_SELECTORS);
        if (checkoutEl) {
            interceptFlow({ mode: "checkout", clickedEl: checkoutEl, event: e }).catch((err) =>
                log("checkout click error:", err)
            );
        }
    },
    true
);

log("Loaded ✅", { page: location.pathname, productId: window.BINGA_BUY_NOW?.productId });
}) ();
