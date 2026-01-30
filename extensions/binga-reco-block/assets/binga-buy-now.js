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
        "[data-testid='Checkout-button']",
    ].join(",");

    const CHECKOUT_SELECTORS = [
        "button[name='checkout']",
        "form[action^='/cart'] button[type='submit'][name='checkout']",
        "a[href^='/checkout']",
        "button[href^='/checkout']",
    ].join(",");

    const UPSALE_MARKER_KEY = "_binga_upsell";
    const UPSALE_MARKER_VALUE = "1";

    async function getCart() {
        const res = await fetch("/cart.js", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error("cart_fetch_failed");
        return res.json();
    }

    async function addVariantToCart(variantId, quantity, properties) {
        const body = { id: Number(variantId), quantity: Number(quantity || 1) };
        if (properties && typeof properties === "object") body.properties = properties;

        const res = await fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            let msg = "add_to_cart_failed";
            try {
                const j = await res.json();
                msg = j?.description || j?.message || msg;
            } catch { }
            throw new Error(msg);
        }
        return res.json();
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
        return idx >= 0 ? idx + 1 : null; // Shopify uses 1-based line index
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

    function setCartCount(cart) {
        const el = document.querySelector("#binga-cart-count");
        if (!el) return;
        const count = Number(cart?.item_count ?? 0);
        el.textContent = String(count);
    }

    const money = (n) => {
        const x = Number(n);
        if (!Number.isFinite(x)) return "";
        return `$${x.toFixed(2)}`;
    };

    function calcDiscount(priceStr, percent) {
        const p = Number(priceStr);
        const pct = Number(percent);
        if (!Number.isFinite(p) || !Number.isFinite(pct)) return { original: "", discounted: "" };
        const d = p * (1 - pct / 100);
        return { original: money(p), discounted: money(d) };
    }

    function openModalSkeleton() {
        const overlay = document.createElement("div");
        overlay.id = "binga-buy-now-overlay";
        overlay.innerHTML = `
      <style>
        #binga-buy-now-overlay{ position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:999999; display:flex; align-items:center; justify-content:center; padding:16px; }
        #binga-buy-now-modal{ width:min(760px,100%); background:#fff; border-radius:14px; padding:24px; box-shadow:0 20px 60px rgba(0,0,0,.25); font-family:inherit; max-height:80vh; overflow-y:auto; }
        #binga-buy-now-modal h3{ margin:0 0 10px 0; font-size:18px; font-weight:600; }

        .binga-cartline{ margin:8px 0 0; font-size:13px; color:#444; }
        .binga-cartline strong{ font-weight:700; }

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
          font-size:14px;
          color:#333;
          margin-bottom:10px;
          line-height:1.3;
        }

        .binga-product-price .orig{ text-decoration:line-through; opacity:.55; font-size:13px; }
        .binga-product-price .disc{ font-size:16px; font-weight:700; }
        .binga-product-price .pct{ opacity:.7; font-size:12px; margin-left:6px; }

        .binga-action{ margin-top:auto; width:100%; }

        .binga-footer{ display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }

        .binga-btn{
          font-size:14px;
          padding:10px 20px;
          border-radius:6px;
          border:1px solid rgba(0,0,0,.14);
          background:#fff;
          cursor:pointer;
        }

        .binga-btn.primary{ background:#111; color:#fff; border-color:#111; }

        .binga-loading{ padding:40px; text-align:center; font-size:14px; color:#666; }

        /* Stepper */
        .binga-stepper{ display:flex; gap:10px; align-items:center; justify-content:center; }
        .binga-stepper .binga-btn{ padding:8px 14px; }
        .binga-qty{ min-width:24px; text-align:center; font-weight:700; font-size:14px; }
      </style>

      <div id="binga-buy-now-modal" role="dialog" aria-modal="true">
        <h3>Add one more item before checkout?</h3>
        <div class="binga-cartline">Cart items: <strong id="binga-cart-count">—</strong></div>

        <div class="binga-loading">Loading recommendations...</div>

        <div class="binga-footer">
          <button class="binga-btn" id="binga-skip">No thanks, checkout now</button>
        </div>
      </div>
    `;

        function close() {
            overlay.remove();
        }

        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) close();
        });

        document.body.appendChild(overlay);
        return { close };
    }

    function renderProducts(products, discountPercent, onAddOnly, onCheckoutNow) {
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

        function updateActionUI(variantId, qty) {
            const action = container.querySelector(`.binga-action[data-variant-id="${variantId}"]`);
            if (!action) return;

            if (qty <= 0) action.innerHTML = renderAddButton(variantId);
            else action.innerHTML = renderStepper(variantId, qty);

            bindActionHandlersForVariant(variantId);
        }

        function bindActionHandlersForVariant(variantId) {
            // Add
            const addBtn = container.querySelector(`.binga-add[data-variant-id="${variantId}"]`);
            if (addBtn) {
                addBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    setBusy(variantId, true);
                    const prev = addBtn.textContent;
                    addBtn.textContent = "Adding...";

                    try {
                        const updatedCart = await onAddOnly(variantId);
                        setCartCount(updatedCart);
                        const qty = getVariantQtyFromCart(updatedCart, variantId);
                        updateActionUI(variantId, qty);
                    } catch (err) {
                        log("Add failed:", err);
                        addBtn.textContent = prev || "Add to cart";
                    } finally {
                        setBusy(variantId, false);
                    }
                });
                return;
            }

            // Plus
            const plusBtn = container.querySelector(`.binga-plus[data-variant-id="${variantId}"]`);
            if (plusBtn) {
                plusBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    setBusy(variantId, true);
                    try {
                        const cart = await getCart();
                        const line = getLineIndexForVariant(cart, variantId);
                        const currentQty = getVariantQtyFromCart(cart, variantId);
                        if (!line) throw new Error("line_not_found");

                        const updatedCart = await changeLineQuantity(line, currentQty + 1);
                        setCartCount(updatedCart);
                        updateActionUI(variantId, currentQty + 1);
                    } catch (err) {
                        log("Plus failed:", err);
                    } finally {
                        setBusy(variantId, false);
                    }
                });
            }

            // Minus
            const minusBtn = container.querySelector(`.binga-minus[data-variant-id="${variantId}"]`);
            if (minusBtn) {
                minusBtn.addEventListener("click", async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

                    setBusy(variantId, true);
                    try {
                        const cart = await getCart();
                        const line = getLineIndexForVariant(cart, variantId);
                        const currentQty = getVariantQtyFromCart(cart, variantId);
                        if (!line) throw new Error("line_not_found");

                        const nextQty = Math.max(0, currentQty - 1);
                        const updatedCart = await changeLineQuantity(line, nextQty);
                        setCartCount(updatedCart);
                        updateActionUI(variantId, nextQty);
                    } catch (err) {
                        log("Minus failed:", err);
                    } finally {
                        setBusy(variantId, false);
                    }
                });
            }
        }

        if (!products?.length) {
            container.innerHTML = `
        <h3>No recommendations available</h3>
        <div class="binga-cartline">Cart items: <strong id="binga-cart-count">—</strong></div>
        <div class="binga-footer">
          <button class="binga-btn primary" id="binga-checkout-now">Checkout now</button>
        </div>
      `;
            container.querySelector("#binga-checkout-now")?.addEventListener("click", onCheckoutNow);
            getCart().then(setCartCount).catch(() => { });
            return;
        }

        const productsHTML = products
            .map((p) => {
                const { original, discounted } = calcDiscount(p.price, discountPercent);
                return `
          <div class="binga-product">
            ${p.image ? `<img src="${p.image}" alt="${p.title}" />` : ""}
            <div class="binga-product-title">${p.title}</div>

            <div class="binga-product-price">
              <div class="orig">${original}</div>
              <div class="disc">${discounted}<span class="pct">(${discountPercent}% off)</span></div>
            </div>

            <div class="binga-action" data-variant-id="${p.variantId}">
              ${renderAddButton(p.variantId)}
            </div>
          </div>
        `;
            })
            .join("");

        container.innerHTML = `
      <h3>Add one more item before checkout?</h3>
      <div class="binga-cartline">Cart items: <strong id="binga-cart-count">—</strong></div>

      <div class="binga-products">${productsHTML}</div>

      <div class="binga-footer">
        <button class="binga-btn" id="binga-skip">Checkout now</button>
      </div>
    `;

        container.querySelector("#binga-skip")?.addEventListener("click", onCheckoutNow);

        (async () => {
            try {
                const cart = await getCart();
                setCartCount(cart);
                products.forEach((p) => {
                    const qty = getVariantQtyFromCart(cart, p.variantId);
                    updateActionUI(String(p.variantId), qty);
                });
            } catch { }
        })();
    }

    async function fetchRecommendations(excludeCsv) {
        const url = `/apps/binga-reco/recommend?limit=3&exclude=${encodeURIComponent(excludeCsv)}`;
        log("Fetching recommendations:", url);

        const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        const out = await res.json();
        log("Proxy response:", out);

        return {
            products: out?.ok ? (out.products || []) : [],
            discountPercent: Number(out?.discountPercent ?? 10),
        };
    }

    async function interceptFlow({ mode, clickedEl, event }) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

        log("Intercepted:", mode);

        const { close } = openModalSkeleton();

        let cart;
        try {
            cart = await getCart();
            setCartCount(cart);
        } catch (e) {
            log("Cart fetch failed:", e);
            close();
            if (mode === "buy_now") location.href = "/checkout";
            return;
        }

        const excludeFromCart = (cart.items || []).map((i) => String(i.product_id));
        const currentProductId = window.BINGA_BUY_NOW?.productId ? String(window.BINGA_BUY_NOW.productId) : null;
        const exclude = [...excludeFromCart, currentProductId].filter(Boolean).join(",");

        let products = [];
        let discountPercent = 10;

        try {
            const reco = await fetchRecommendations(exclude);
            discountPercent = reco.discountPercent;
            products = (reco.products || []).filter((p) => p.available !== false);
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
            discountPercent,

            // onAddOnly: add recommended item ONLY, and mark it for the Function
            async (selectedVariantId) => {
                await addVariantToCart(Number(selectedVariantId), 1, { [UPSALE_MARKER_KEY]: UPSALE_MARKER_VALUE });
                const newCart = await getCart();
                return newCart;
            },

            // onCheckoutNow
            async () => {
                close();

                if (mode === "buy_now") {
                    const { variantId, qty } = getMainVariantAndQty(clickedEl);
                    if (variantId) await addVariantToCart(variantId, qty);
                }

                location.href = "/checkout";
            }
        );
    }

    document.addEventListener(
        "click",
        (e) => {
            const buyNowBtn = e.target?.closest?.(BUY_NOW_SELECTORS);
            if (buyNowBtn) {
                interceptFlow({ mode: "buy_now", clickedEl: buyNowBtn, event: e }).catch((err) => log("buy_now error:", err));
                return;
            }

            const checkoutEl = e.target?.closest?.(CHECKOUT_SELECTORS);
            if (checkoutEl) {
                interceptFlow({ mode: "checkout", clickedEl: checkoutEl, event: e }).catch((err) => log("checkout error:", err));
            }
        },
        true
    );

    log("Loaded ✅", { page: location.pathname, productId: window.BINGA_BUY_NOW?.productId });
})();
