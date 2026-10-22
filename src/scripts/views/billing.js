// QuickBill — Billing (POS checkout) view, Phase 4.
//
// Live checkout: scan barcodes, search the catalogue, build a cart, apply
// a discount and tax, choose cash or unpaid, and complete the sale. The
// authoritative checkout — prices, stock checks, totals, bill number, stock
// deduction — runs in the main process inside a single SQLite transaction.
//
// The renderer only sends barcode + quantity + payment intent. The main
// process is responsible for: verifying each product still exists, checking
// sufficient stock, recomputing totals, generating a unique bill number,
// persisting the sale + items, and decrementing stock atomically. If any
// step fails the entire transaction rolls back and the renderer surfaces a
// precise error (insufficient stock / unknown barcode / database error /
// bill-number collision).
//
// Currency math: integer paise (`../lib/money.js`). All cart math is
// reproducible from the database read inside the transaction.

import {
  formatINR, isValidAmount, fromRupees, parseAmount,
  formatCurrency, formatCurrencyValue
} from '../lib/money.js';
import { createCart, CartError } from '../lib/cart.js';
import { buildReceiptDocuments } from '../lib/receipt.js';
import { loadReceiptForSale, listPrinters, printSaleReceipt } from '../lib/print.js';

// The preload bridge is resolved lazily: app.js imports this module
// statically, so a missing `window.quickbill` must not throw here and take
// the whole app shell down with it.
function bridge() {
  return window.quickbill || null;
}
function productsApi()  { return bridge()?.products || null; }
function salesApi()     { return bridge()?.sales || null; }
function settingsApi()  { return bridge()?.settings || null; }

const MAX_SEARCH_RESULTS = 12;
const SEARCH_DEBOUNCE_MS = 140;
// Upper bound the main process enforces on `taxPercent` at checkout.
const MAX_TAX_PERCENT = 1000;

// The billing view currently mounted, or null when detached. The shell's
// quick search dispatches `quickbill:quick-pick` after navigating here, so
// this module-level handle is how that barcode reaches the live cart.
let mountedRoot = null;
let addByBarcode = null;

window.addEventListener('quickbill:quick-pick', (e) => {
  if (!mountedRoot || !mountedRoot.isConnected) return;
  if (e.detail?.kind !== 'product') return;
  const barcode = String(e.detail.id ?? '').trim();
  if (!barcode || typeof addByBarcode !== 'function') return;
  addByBarcode(barcode);
});

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  // Lets dispose() drop a pending run instead of letting it paint a
  // detached view.
  wrapped.cancel = () => { clearTimeout(t); t = null; };
  return wrapped;
}

// `crypto.randomUUID()` is available in Electron 31's renderer; fall back
// to a timestamp + random suffix so older targets still get unique IDs.
function newClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `qb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Whoever is signed in at the till, read from the shell's topbar so the
// ledger and the header can never disagree.
function currentCashierName() {
  const name = window.__quickbill?.currentCashierName?.();
  return String(name || '').trim() || 'Cashier';
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderBilling() {
  const root = document.createElement('div');
  root.className = 'view view--billing';

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Billing</h1>
        <p>Scan a barcode, search the catalogue, collect payment and complete the sale. Sales, items and stock are saved in a single database transaction.</p>
      </div>
      <div class="page-header__actions">
        <button class="btn" data-action="clear-cart">Clear cart</button>
      </div>
    </div>

    <div class="pos-grid">

      <!-- LEFT — capture -->
      <div class="pos-col pos-col--capture">

        <div class="card pos-capture__scan">
          <div class="card__header">
            <div>
              <div class="card__title">Scan barcode / SKU</div>
              <div class="card__subtitle">USB scanners act as keyboards and finish with <kbd>Enter</kbd>.</div>
            </div>
            <div class="pos-shortcuts" aria-hidden="true">
              <span><kbd>F2</kbd> focus</span>
            </div>
          </div>
          <div class="card__body pos-scan">
            <div class="pos-scan__input-wrap">
              <span class="pos-scan__icon" aria-hidden="true">▣</span>
              <input class="input pos-scan__input"
                     data-role="scan"
                     type="text"
                     inputmode="text"
                     autocomplete="off"
                     autocapitalize="off"
                     spellcheck="false"
                     placeholder="Scan or type a barcode and press Enter…" />
              <button class="btn btn--ghost pos-scan__clear" data-role="scan-clear" aria-label="Clear scan input" hidden>✕</button>
            </div>
            <div class="pos-scan__hint" data-role="scan-hint">Tip: press <kbd>F2</kbd> from anywhere on this screen to refocus.</div>
            <div class="pos-banner pos-banner--error" data-role="scan-error" hidden></div>
            <div class="pos-banner pos-banner--success" data-role="scan-success" hidden></div>
          </div>
        </div>

        <div class="card pos-capture__search">
          <div class="card__header">
            <div>
              <div class="card__title">Search catalogue</div>
              <div class="card__subtitle">By name, SKU or barcode. Click a result to add it to the cart.</div>
            </div>
            <div class="pos-shortcuts" aria-hidden="true">
              <span><kbd>F4</kbd> focus</span>
            </div>
          </div>
          <div class="card__body pos-search">
            <input class="input pos-search__input"
                   data-role="search"
                   type="search"
                   placeholder="Search products…"
                   autocomplete="off"
                   spellcheck="false" />
            <div class="pos-search__results" data-role="results" aria-live="polite">
              <div class="pos-empty pos-empty--soft">Start typing to search the catalogue.</div>
            </div>
          </div>
        </div>

      </div>

      <!-- RIGHT — invoice -->
      <div class="pos-col pos-col--invoice">
        <div class="card pos-invoice">
          <div class="card__header">
            <div>
              <div class="card__title">Current invoice</div>
              <div class="card__subtitle" data-role="invoice-subtitle">0 items · unpaid</div>
            </div>
            <div class="pos-shortcuts" aria-hidden="true">
              <span data-role="item-count" class="pos-pill">0</span>
            </div>
          </div>

          <div class="card__body pos-invoice__body" data-role="cart-body">
            <!-- repainted by renderCart(state) -->
          </div>

          <div class="card__header pos-invoice__adjust" data-role="adjust" hidden>
            <div class="pos-adjust">
              <label class="pos-adjust__field">
                <span class="pos-adjust__label">Discount (₹)</span>
                <input class="input pos-adjust__input"
                       data-role="discount"
                       type="text"
                       inputmode="decimal"
                       autocomplete="off"
                       value="0" />
                <span class="pos-adjust__err" data-role="discount-err" hidden></span>
              </label>
              <label class="pos-adjust__field">
                <span class="pos-adjust__label">Tax (%)</span>
                <input class="input pos-adjust__input"
                       data-role="tax"
                       type="text"
                       inputmode="decimal"
                       autocomplete="off"
                       value="0" />
                <span class="pos-adjust__err" data-role="tax-err" hidden></span>
              </label>
            </div>
          </div>

          <div class="card__body pos-totals" data-role="totals">
            <!-- repainted by renderTotals(state) -->
          </div>

          <div class="card__body pos-payment" data-role="payment" hidden>
            <div class="pos-payment__row">
              <span class="pos-payment__label">Payment method</span>
              <div class="pos-payment__toggle" role="radiogroup" aria-label="Payment method">
                <label class="pos-payment__opt">
                  <input type="radio" name="pay_method" value="cash" data-role="pay-method" checked />
                  <span>Cash</span>
                </label>
                <label class="pos-payment__opt">
                  <input type="radio" name="pay_method" value="unpaid" data-role="pay-method" />
                  <span>Unpaid (credit)</span>
                </label>
              </div>
            </div>

            <div class="pos-payment__row" data-role="cash-row">
              <label class="pos-adjust__field pos-payment__received">
                <span class="pos-adjust__label">Amount received (₹)</span>
                <input class="input pos-adjust__input"
                       data-role="amount-received"
                       type="text"
                       inputmode="decimal"
                       autocomplete="off"
                       value="0" />
                <span class="pos-adjust__err" data-role="amount-err" hidden></span>
              </label>
              <div class="pos-payment__change">
                <span class="pos-payment__label">Change due</span>
                <span class="pos-payment__change-value" data-role="change-due">₹0.00</span>
              </div>
            </div>

            <div class="pos-payment__row pos-payment__status" data-role="payment-summary" hidden>
              <span class="pos-payment__label">Status</span>
              <span class="pos-payment__status-pill" data-role="payment-status-pill">—</span>
            </div>
          </div>

          <div class="card__body pos-checkout">
            <button class="btn btn--primary pos-checkout__btn" data-action="checkout" disabled>
              Complete sale
            </button>
            <p class="pos-checkout__hint" data-role="checkout-hint">
              Add at least one product to enable checkout.
            </p>
          </div>
        </div>
      </div>

    </div>

    <!-- Last receipt confirmation modal. Hidden by default. -->
    <div class="modal" data-role="receipt-modal" hidden></div>

    <div class="toast" data-role="toast" hidden></div>
  `;

  // ---- element refs ----
  const scanInputEl       = root.querySelector('[data-role="scan"]');
  const scanClearBtn      = root.querySelector('[data-role="scan-clear"]');
  const scanErrorEl       = root.querySelector('[data-role="scan-error"]');
  const scanSuccessEl     = root.querySelector('[data-role="scan-success"]');
  const scanHintEl        = root.querySelector('[data-role="scan-hint"]');
  const searchInputEl     = root.querySelector('[data-role="search"]');
  const resultsEl         = root.querySelector('[data-role="results"]');
  const cartBodyEl        = root.querySelector('[data-role="cart-body"]');
  const adjustEl          = root.querySelector('[data-role="adjust"]');
  const discountInputEl   = root.querySelector('[data-role="discount"]');
  const discountErrEl     = root.querySelector('[data-role="discount-err"]');
  const taxInputEl        = root.querySelector('[data-role="tax"]');
  const taxErrEl          = root.querySelector('[data-role="tax-err"]');
  const totalsEl          = root.querySelector('[data-role="totals"]');
  const paymentEl         = root.querySelector('[data-role="payment"]');
  const cashRowEl         = root.querySelector('[data-role="cash-row"]');
  const amountReceivedEl  = root.querySelector('[data-role="amount-received"]');
  const amountErrEl       = root.querySelector('[data-role="amount-err"]');
  const changeDueEl       = root.querySelector('[data-role="change-due"]');
  const paymentSummaryEl  = root.querySelector('[data-role="payment-summary"]');
  const paymentPillEl     = root.querySelector('[data-role="payment-status-pill"]');
  const payMethodRadios   = root.querySelectorAll('[data-role="pay-method"]');
  const invoiceSubtitleEl = root.querySelector('[data-role="invoice-subtitle"]');
  const itemCountEl       = root.querySelector('[data-role="item-count"]');
  const checkoutBtn       = root.querySelector('[data-action="checkout"]');
  const checkoutHintEl    = root.querySelector('[data-role="checkout-hint"]');
  const receiptModalEl    = root.querySelector('[data-role="receipt-modal"]');
  const toastEl           = root.querySelector('[data-role="toast"]');

  // ---- state ----
  const cart = createCart({ defaultTaxPercent: 0 });
  /** @type {Map<string, object>} productsCache — keyed by barcode */
  let productsCache = new Map();
  let allProducts   = [];
  let productsLoaded = false;
  let scanErrorTimer = null;
  let scanSuccessTimer = null;
  let scanFlashTimer = null;
  let searchToken = 0;               // in-flight guard for runSearch
  let catalogueReady = null;        // in-flight catalogue load
  let checkoutInFlight = false;       // single-flight checkout guard
  let lastCheckoutSale = null;        // most recent successful sale (for receipt modal)
  let storeTaxPercent = 0;            // last rate hydrated from settings
  let taxEditedByUser = false;        // cashier typed a rate — do not overwrite
  let disposed = false;

  // -------------------------------------------------------------------------
  // Catalogue cache
  // -------------------------------------------------------------------------

  async function loadCatalogue() {
    const api = productsApi();
    if (!api) {
      showToast('Product data is unavailable.', 'error');
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--error">Catalogue unavailable.</div>`;
      return;
    }
    let res;
    try {
      res = await api.list({});
    } catch (err) {
      showToast(`Could not load catalogue: ${err?.message || 'unexpected error'}`, 'error');
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--error">Catalogue unavailable.</div>`;
      return;
    }
    if (!res.ok) {
      showToast(`Could not load catalogue: ${res.error.message}`, 'error');
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--error">Catalogue unavailable.</div>`;
      return;
    }
    allProducts = res.data;
    productsCache = new Map(allProducts.map((p) => [String(p.barcode).trim(), p]));
    productsLoaded = true;
    scanHintEl.textContent = productsCache.size
      ? `${productsCache.size} products loaded. Scan a barcode or press F4 to search.`
      : 'No products in the catalogue. Add some from the Products tab.';
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async function runSearch(term) {
    const q = String(term || '').trim();
    // Monotonic token: a slower earlier query must never paint over the
    // results of a later one.
    const token = ++searchToken;
    if (!q) {
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--soft">Start typing to search the catalogue.</div>`;
      return;
    }
    if (!productsLoaded) {
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--soft">Loading catalogue…</div>`;
      return;
    }
    const api = productsApi();
    if (!api) {
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--error">Catalogue unavailable.</div>`;
      return;
    }
    const res = await api.list({ search: q });
    if (token !== searchToken) return;
    if (!res.ok) {
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--error">Search failed: ${escapeHtml(res.error.message)}</div>`;
      return;
    }
    const list = res.data.slice(0, MAX_SEARCH_RESULTS);
    if (!list.length) {
      resultsEl.innerHTML = `<div class="pos-empty pos-empty--soft">No products match “${escapeHtml(q)}”.</div>`;
      return;
    }
    resultsEl.innerHTML = `
      <table class="table table--compact pos-results__table">
        <thead>
          <tr>
            <th>Product</th>
            <th>SKU</th>
            <th>Barcode</th>
            <th class="num">Price</th>
            <th class="num">Stock</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${list.map(renderResultRow).join('')}
        </tbody>
      </table>
      ${res.data.length > MAX_SEARCH_RESULTS
        ? `<div class="pos-results__more">Showing ${MAX_SEARCH_RESULTS} of ${res.data.length} matches — refine your search to narrow down.</div>`
        : ''}`;
  }

  function renderResultRow(p) {
    const low = Number(p.stock_quantity) <= Number(p.min_stock_level);
    return `
      <tr data-barcode="${escapeHtml(p.barcode)}">
        <td>
          <div class="pos-result__name">${escapeHtml(p.name)}</div>
          <div class="pos-result__meta"><span class="pill pill--category">${escapeHtml(p.category)}</span></div>
        </td>
        <td><span class="mono-code">${escapeHtml(p.sku)}</span></td>
        <td><span class="muted-code">${escapeHtml(p.barcode)}</span></td>
        <td class="num"><strong>${formatINR(fromRupees(p.selling_price))}</strong></td>
        <td class="num ${low ? 'pos-result__low' : ''}">${escapeHtml(p.stock_quantity)}</td>
        <td class="actions">
          <button class="btn btn--primary pos-result__add" data-action="add-result" data-barcode="${escapeHtml(p.barcode)}">+ Add</button>
        </td>
      </tr>`;
  }

  // -------------------------------------------------------------------------
  // Cart rendering
  // -------------------------------------------------------------------------

  function renderCart(state) {
    const itemsText = state.isEmpty
      ? '0 items · unpaid'
      : `${state.itemCount} item${state.itemCount === 1 ? '' : 's'} · preview until checkout`;
    invoiceSubtitleEl.textContent = itemsText;
    itemCountEl.textContent = String(state.itemCount);
    itemCountEl.classList.toggle('pos-pill--accent', !state.isEmpty);

    if (state.isEmpty) {
      cartBodyEl.innerHTML = `
        <div class="pos-empty">
          <div class="pos-empty__icon" aria-hidden="true">▤</div>
          <div class="pos-empty__title">Cart is empty</div>
          <div class="pos-empty__hint">Scan a barcode or search the catalogue to start an invoice.</div>
        </div>`;
      adjustEl.hidden     = true;
      paymentEl.hidden    = true;
      checkoutBtn.disabled = true;
      checkoutHintEl.textContent = 'Add at least one product to enable checkout.';
      return;
    }

    adjustEl.hidden  = false;
    paymentEl.hidden = false;
    cartBodyEl.innerHTML = `
      <table class="table table--compact pos-cart__table">
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Price</th>
            <th class="num">Qty</th>
            <th class="num">Total</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${state.lines.map(renderCartRow).join('')}
        </tbody>
      </table>`;
    checkoutBtn.disabled = checkoutInFlight;
    checkoutHintEl.textContent = checkoutInFlight
      ? 'Saving sale…'
      : 'Click “Complete sale” to record the invoice and decrement stock.';
  }

  function renderCartRow(line) {
    return `
      <tr data-barcode="${escapeHtml(line.barcode)}">
        <td>
          <div class="pos-cart__name">${escapeHtml(line.name)}</div>
          <div class="pos-cart__meta">
            <span class="mono-code">${escapeHtml(line.sku)}</span>
            <span class="muted-code">${escapeHtml(line.barcode)}</span>
          </div>
        </td>
        <td class="num">${formatINR(line.unitPricePaise)}</td>
        <td class="num">
          <div class="pos-qty">
            <button class="btn btn--ghost pos-qty__btn" data-action="dec" data-barcode="${escapeHtml(line.barcode)}" aria-label="Decrease quantity">−</button>
            <input class="input pos-qty__input"
                   type="text"
                   inputmode="numeric"
                   autocomplete="off"
                   value="${line.quantity}"
                   data-role="qty"
                   data-barcode="${escapeHtml(line.barcode)}"
                   aria-label="Quantity for ${escapeHtml(line.name)}" />
            <button class="btn btn--ghost pos-qty__btn" data-action="inc" data-barcode="${escapeHtml(line.barcode)}" aria-label="Increase quantity">+</button>
          </div>
          <div class="pos-qty__err" data-role="qty-err" data-barcode="${escapeHtml(line.barcode)}" hidden></div>
        </td>
        <td class="num"><strong>${formatINR(line.lineTotalPaise)}</strong></td>
        <td class="actions">
          <button class="btn btn--ghost pos-cart__remove" data-action="remove" data-barcode="${escapeHtml(line.barcode)}" aria-label="Remove ${escapeHtml(line.name)}">✕</button>
        </td>
      </tr>`;
  }

  // Every cart repaint replaces cartBodyEl.innerHTML, so the +/- button the
  // cashier just pressed is gone and focus falls back to <body>. Put focus
  // back on the same control so a run of presses keeps working.
  function refocusQtyControl(barcode, action) {
    const row = cartBodyEl.querySelector(`tr[data-barcode="${CSS.escape(barcode)}"]`);
    if (!row) {
      // The line was removed (quantity 1 → "−"): the scan field is the
      // natural place to continue.
      scanInputEl.focus();
      return;
    }
    const target = row.querySelector(`[data-action="${action}"]`) || row.querySelector('[data-role="qty"]');
    if (target) target.focus();
  }

  function renderTotals(state) {
    totalsEl.innerHTML = `
      <div class="pos-totals__row">
        <span>Items</span>
        <span class="pos-totals__value">${state.itemCount}</span>
      </div>
      <div class="pos-totals__row">
        <span>Subtotal</span>
        <span class="pos-totals__value">${formatINR(state.subtotalPaise)}</span>
      </div>
      <div class="pos-totals__row ${state.discountPaise > 0 ? '' : 'pos-totals__row--muted'}">
        <span>Discount</span>
        <span class="pos-totals__value">− ${formatINR(state.discountPaise)}</span>
      </div>
      <div class="pos-totals__row ${state.taxPaise > 0 ? '' : 'pos-totals__row--muted'}">
        <span>Tax (${Number(state.taxPercent).toFixed(2)}%)</span>
        <span class="pos-totals__value">${formatINR(state.taxPaise)}</span>
      </div>
      <div class="pos-totals__row pos-totals__row--final">
        <span>Total payable</span>
        <span class="pos-totals__value">${formatINR(state.totalPaise)}</span>
      </div>`;
  }

  function renderPaymentSummary(state) {
    const method = getPaymentMethod();
    if (method === 'unpaid') {
      cashRowEl.hidden = true;
      paymentSummaryEl.hidden = false;
      paymentPillEl.className = 'pos-payment__status-pill pill pill--pending';
      paymentPillEl.textContent = 'Unpaid';
      changeDueEl.textContent = formatINR(0);
    } else {
      cashRowEl.hidden = false;
      paymentSummaryEl.hidden = false;
      // Recompute the live "change due" preview using the authoritative total.
      const totalPaise = state.totalPaise;
      // One reader for the whole view: an empty field means the customer
      // paid exactly the total, which is what checkout then records.
      const { paise: usableReceived, valid: amountValid } = readAmountReceived(totalPaise);
      const change = Math.max(0, usableReceived - totalPaise);
      changeDueEl.textContent = formatINR(change);
      amountErrEl.hidden = amountValid;
      amountReceivedEl.classList.toggle('pos-adjust__input--error', !amountValid);
      if (!amountValid) amountErrEl.textContent = 'Enter a valid amount, e.g. 50';
      if (totalPaise === 0) {
        paymentPillEl.className = 'pos-payment__status-pill pill pill--paid';
        paymentPillEl.textContent = 'Paid';
      } else if (usableReceived >= totalPaise) {
        paymentPillEl.className = 'pos-payment__status-pill pill pill--paid';
        paymentPillEl.textContent = 'Paid';
      } else if (usableReceived > 0) {
        paymentPillEl.className = 'pos-payment__status-pill pill pill--pending';
        paymentPillEl.textContent = 'Partial';
      } else {
        paymentPillEl.className = 'pos-payment__status-pill pill pill--pending';
        paymentPillEl.textContent = 'Unpaid';
      }
    }
  }

  function getPaymentMethod() {
    for (const r of payMethodRadios) if (r.checked) return r.value;
    return 'cash';
  }

  const cartUnsubscribe = cart.subscribe((state) => { renderCart(state); renderTotals(state); renderPaymentSummary(state); });

  // -------------------------------------------------------------------------
  // Banners / toast
  // -------------------------------------------------------------------------

  function showScanError(message) {
    scanErrorEl.textContent = message;
    scanErrorEl.hidden = false;
    scanSuccessEl.hidden = true;
    clearTimeout(scanErrorTimer);
    scanErrorTimer = setTimeout(() => { scanErrorEl.hidden = true; }, 4000);
  }

  function showScanSuccess(message) {
    scanSuccessEl.textContent = message;
    scanSuccessEl.hidden = false;
    scanErrorEl.hidden = true;
    clearTimeout(scanSuccessTimer);
    scanSuccessTimer = setTimeout(() => { scanSuccessEl.hidden = true; }, 1800);
  }

  function showToast(message, kind = 'success') {
    toastEl.textContent = message;
    toastEl.className = `toast toast--${kind}`;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 3000);
  }

  function flashScanInputError() {
    scanInputEl.classList.add('pos-scan__input--error');
    clearTimeout(scanFlashTimer);
    scanFlashTimer = setTimeout(() => scanInputEl.classList.remove('pos-scan__input--error'), 600);
  }

  // -------------------------------------------------------------------------
  // Cart actions
  // -------------------------------------------------------------------------

  function addProductToCart(product, qty = 1) {
    try {
      cart.add(product, qty);
      return true;
    } catch (e) {
      const msg = e instanceof CartError ? e.message : 'Could not add product.';
      showScanError(msg);
      return false;
    }
  }

  // Resolve a scanned / picked barcode against the catalogue and add it.
  // Waits for the first catalogue load so a scan that lands during startup
  // is not silently dropped.
  async function addBarcodeToCart(rawBarcode) {
    const code = String(rawBarcode || '').trim();
    if (!code) return;
    if (!productsLoaded && catalogueReady) {
      // A failed load already painted its own error; never let the rejection
      // escape into the keydown handler.
      await catalogueReady.catch(() => {});
    }
    if (disposed) return;
    if (!productsLoaded) {
      showScanError('Catalogue is unavailable — could not add the product.');
      return;
    }
    const product = productsCache.get(code);
    if (!product) {
      showScanError(`Unknown barcode: ${code}`);
      flashScanInputError();
      return;
    }
    // addProductToCart reports stock caps / failures on the error banner.
    if (!addProductToCart(product, 1)) return;
    scanInputEl.value = '';
    scanClearBtn.hidden = true;
    showScanSuccess(`Added ${product.name}`);
    scanInputEl.focus();
  }

  function handleScan(rawValue) {
    addBarcodeToCart(rawValue);
  }

  function applyDiscountFromInput() {
    const raw = discountInputEl.value;
    if (!isValidAmount(raw) && String(raw).trim() !== '' && String(raw).trim() !== '0') {
      discountErrEl.textContent = 'Enter a valid amount, e.g. 5 or 5.50';
      discountErrEl.hidden = false;
      discountInputEl.classList.add('pos-adjust__input--error');
      return;
    }
    discountErrEl.hidden = true;
    discountInputEl.classList.remove('pos-adjust__input--error');
    try { cart.setDiscount(raw); }
    catch (e) { showToast(e.message, 'error'); }
  }

  function applyTaxFromInput() {
    const raw = String(taxInputEl.value).trim();
    const fail = (msg) => {
      taxErrEl.textContent = msg;
      taxErrEl.hidden = false;
      taxInputEl.classList.add('pos-adjust__input--error');
    };
    if (raw === '') return fail('Enter a percentage, e.g. 5');
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fail('Enter a valid percentage ≥ 0');
    // The main process rejects anything above this at checkout, so catch it
    // here with a message that names the limit.
    if (n > MAX_TAX_PERCENT) return fail(`Tax cannot exceed ${MAX_TAX_PERCENT}%`);
    taxErrEl.hidden = true;
    taxInputEl.classList.remove('pos-adjust__input--error');
    try {
      cart.setTaxPercent(n);
      taxEditedByUser = true;
    } catch (e) {
      fail(e.message);
    }
  }

  function applyQtyFromInput(inputEl) {
    const barcode = inputEl.dataset.barcode;
    const raw = inputEl.value.trim();
    const parsed = Number(raw);
    // A barcode may contain quotes or backslashes, which would make the
    // attribute selector throw — escape before interpolating it.
    const errSelector = `[data-role="qty-err"][data-barcode="${CSS.escape(barcode)}"]`;
    const showErr = (msg) => {
      const errEl = root.querySelector(errSelector);
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      inputEl.classList.add('pos-qty__input--error');
    };
    const clearErr = () => {
      const errEl = root.querySelector(errSelector);
      if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
      inputEl.classList.remove('pos-qty__input--error');
    };
    if (raw === '' || !Number.isFinite(parsed)) {
      return showErr('Enter a number');
    }
    if (!Number.isInteger(parsed)) {
      return showErr('Whole numbers only');
    }
    if (parsed < 1) {
      return showErr('At least 1');
    }
    try {
      cart.setQuantity(barcode, parsed);
      clearErr();
    } catch (e) {
      showErr(e.message);
    }
  }

  // Integer-paise parser for the amount-received field. Delegates to
  // money.parseAmount (which accepts ".5" and "12.") and keeps the
  // null-on-invalid contract the callers expect.
  function parseAmountPaise(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    try { return parseAmount(raw); }
    catch { return null; }
  }

  // Reads the amount-received field. An empty field means the customer
  // handed over exactly the total — the preview pill, the change preview and
  // the recorded sale all agree on that single rule.
  function readAmountReceived(totalPaise) {
    const parsed = parseAmountPaise(amountReceivedEl.value);
    if (parsed === null) {
      const empty = String(amountReceivedEl.value ?? '').trim() === '';
      return {
        paise: empty ? Math.max(0, totalPaise) : 0,
        valid: empty
      };
    }
    return { paise: parsed, valid: true };
  }

  // -------------------------------------------------------------------------
  // Checkout — Phase 4
  // -------------------------------------------------------------------------

  async function completeCheckout() {
    if (checkoutInFlight) return;     // single-flight guard
    // The receipt modal's backdrop blocks the mouse but not the keyboard, so
    // F9 could otherwise re-submit the sale that was just recorded.
    if (!receiptModalEl.hidden) return;
    const state = cart.getState();
    if (state.isEmpty) {
      showToast('Cart is empty.', 'error');
      return;
    }
    const api = salesApi();
    if (!api) {
      showToast('Sales API is unavailable.', 'error');
      return;
    }
    const method = getPaymentMethod();
    let amountReceivedPaise = 0;
    if (method === 'cash') {
      // Same rule as the preview: an empty field records exact payment.
      const received = readAmountReceived(state.totalPaise);
      if (!received.valid) {
        amountErrEl.textContent = 'Enter a valid amount, e.g. 50';
        amountErrEl.hidden = false;
        amountReceivedEl.classList.add('pos-adjust__input--error');
        return;
      }
      amountReceivedPaise = received.paise;
    }

    checkoutInFlight = true;
    checkoutBtn.disabled = true;
    checkoutBtn.classList.add('pos-checkout__btn--loading');
    checkoutBtn.textContent = 'Saving sale…';
    checkoutHintEl.textContent = 'Recording sale, decrementing stock and generating a unique bill number…';
    const reqId = newClientRequestId();

    const items = state.lines.map((l) => ({ barcode: l.barcode, quantity: l.quantity }));
    const payload = {
      clientRequestId: reqId,
      items,
      discountPaise: state.discountPaise,
      taxPercent:    state.taxPercent,
      payment:       { method, amountReceivedPaise },
      cashierName:   currentCashierName()
    };

    try {
      const res = await api.create(payload);
      if (!res.ok) {
        handleCheckoutError(res.error);
        return;
      }
      const { sale, replayed } = res.data;
      onCheckoutSuccess(sale, replayed);
    } catch (err) {
      // Defensive — the preload bridge never throws; if a future change does,
      // we still surface a useful message instead of an empty render.
      showToast(`Checkout failed: ${err?.message || 'unexpected error'}`, 'error');
    } finally {
      checkoutInFlight = false;
      // Read the cart as it is *now*: a successful sale empties it, and the
      // button must stay disabled until the cashier starts a new invoice.
      const live = cart.getState();
      checkoutBtn.disabled = live.isEmpty;
      checkoutBtn.classList.remove('pos-checkout__btn--loading');
      checkoutBtn.textContent = 'Complete sale';
      checkoutHintEl.textContent = live.isEmpty
        ? 'Add at least one product to enable checkout.'
        : 'Click “Complete sale” to record the invoice and decrement stock.';
    }
  }

  function handleCheckoutError(error) {
    if (!error) {
      showToast('Checkout failed: unknown error.', 'error');
      return;
    }
    if (error.code === 'INSUFFICIENT_STOCK') {
      const msg = error.message || 'Insufficient stock for one or more items.';
      showToast(msg, 'error');
      showScanError(msg);
      return;
    }
    if (error.code === 'PRODUCT_MISSING') {
      showToast(error.message || 'A product in the cart is no longer available.', 'error');
      return;
    }
    if (error.code === 'VALIDATION') {
      showToast(error.message || 'Please review the cart and try again.', 'error');
      return;
    }
    if (error.code === 'BILL_NUMBER_COLLISION') {
      showToast(error.message || 'Bill number collision. Please try the checkout again.', 'error');
      return;
    }
    showToast(error.message || 'Checkout failed.', 'error');
  }

  function onCheckoutSuccess(sale, replayed) {
    lastCheckoutSale = sale;
    // The sale is in the ledger — the invoice on screen is spent. Emptying
    // the cart here (not on modal close) is what stops the sold lines from
    // being charged a second time. The receipt modal renders from the saved
    // sale, so it is unaffected.
    resetCartUi();
    showReceiptModal(sale, replayed);
    if (!replayed) {
      // Refresh catalogue so subsequent scans see the new stock levels.
      loadCatalogue();
    }
  }

  function showReceiptModal(sale, replayed) {
    lastCheckoutSale = sale;
    // Render using the shared receipt builder so the modal body and the
    // printable document agree byte-for-byte. The renderer is async
    // (it loads the store profile from the main process); show a
    // loading state until it resolves.
    receiptModalEl.innerHTML = `
      <div class="modal__backdrop" data-action="receipt-close"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__header">
          <h2>${replayed ? 'Sale already recorded' : 'Sale complete'}</h2>
          <button class="btn btn--ghost" data-action="receipt-close" aria-label="Close">✕</button>
        </div>
        <div class="modal__body" data-role="receipt-body">
          <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading receipt…</div>
        </div>
        <div class="form-actions" style="padding: 0 20px 20px; gap: 12px;">
          <select class="input" data-role="printer-select" style="max-width: 220px;">
            <option value="">Default printer</option>
          </select>
          <button type="button" class="btn" data-action="receipt-print">Print receipt</button>
          <span style="flex:1"></span>
          <button type="button" class="btn" data-action="receipt-close-and-clear">New sale</button>
          <button type="button" class="btn btn--primary" data-action="receipt-close">Close</button>
        </div>
      </div>`;
    receiptModalEl.hidden = false;
    const bodyEl  = receiptModalEl.querySelector('[data-role="receipt-body"]');
    const selectEl = receiptModalEl.querySelector('[data-role="printer-select"]');
    if (selectEl) {
      listPrinters().then((pr) => {
        if (!pr.ok) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No printers detected';
          selectEl.appendChild(opt);
          selectEl.disabled = true;
          return;
        }
        for (const p of pr.data.printers || []) {
          const o = document.createElement('option');
          o.value = p.name;
          o.textContent = p.displayName && p.displayName !== p.name
            ? `${p.name} — ${p.displayName}`
            : p.name;
          selectEl.appendChild(o);
        }
        if (selectEl.options.length <= 1) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No printers detected';
          selectEl.appendChild(opt);
          selectEl.disabled = true;
        }
      }).catch(() => { /* swallow — print button will surface the error. */ });
    }
    const loadRes = awaitResult(loadReceiptForSale(sale.id));
    loadRes.then((res) => {
      if (!res.ok) {
        bodyEl.innerHTML = `
          <div class="pos-banner pos-banner--error" role="alert">
            ${escapeHtml(res.message || 'Could not load receipt.')}
          </div>
          <p class="muted" style="margin-top: 12px;">
            The sale <code>${escapeHtml(String(sale.id))}</code> is still in the sales ledger;
            reopen it from the Sales History screen to retry.
          </p>`;
        return;
      }
      const docs = buildReceiptDocuments(res.data);
      bodyEl.innerHTML = docs.html + (replayed
        ? '<p class="muted" style="margin-top: 12px; font-size: 12px;">This sale was already recorded earlier — no new entries were created.</p>'
        : '');
    });
  }

  // Lightweight promise thunk for places where we want to kick off a
  // promise and chain its handling inline without an `async` function.
  function awaitResult(p) { return Promise.resolve(p); }

  async function handlePrintReceipt() {
    if (!lastCheckoutSale) return;
    const selectEl = receiptModalEl.querySelector('[data-role="printer-select"]');
    const printer = selectEl ? String(selectEl.value || '') : '';
    const r = await printSaleReceipt(lastCheckoutSale.id, { printer, copies: 1 });
    if (r.ok) {
      showToast('Receipt sent to the printer.');
      return;
    }
    if (r.code === 'PRINTER_CANCELLED') {
      showToast('Print cancelled.');
      return;
    }
    const msg = r.message || 'Printing failed.';
    showToast(msg, 'error');
    showScanError(msg);
  }

  function closeReceiptModal() {
    receiptModalEl.hidden = true;
    receiptModalEl.innerHTML = '';
    lastCheckoutSale = null;
  }

  function closeReceiptModalAndClearCart() {
    closeReceiptModal();
    resetCartUi();
  }

  function resetCartUi() {
    cart.clear();
    discountInputEl.value = '0';
    // The tax rate belongs to the store, not to this invoice — restore the
    // hydrated value so the next sale is not billed at 0%.
    taxInputEl.value      = String(storeTaxPercent);
    taxEditedByUser       = false;
    cart.setTaxPercent(storeTaxPercent);
    amountReceivedEl.value = '0';
    discountErrEl.hidden = true;
    taxErrEl.hidden = true;
    amountErrEl.hidden = true;
    discountInputEl.classList.remove('pos-adjust__input--error');
    taxInputEl.classList.remove('pos-adjust__input--error');
    amountReceivedEl.classList.remove('pos-adjust__input--error');
    payMethodRadios.forEach((r) => { r.checked = (r.value === 'cash'); });
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  scanInputEl.addEventListener('input', () => {
    scanClearBtn.hidden = scanInputEl.value.length === 0;
  });
  scanInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleScan(scanInputEl.value);
    } else if (e.key === 'Escape') {
      scanInputEl.value = '';
      scanClearBtn.hidden = true;
      scanErrorEl.hidden = true;
    }
  });
  scanClearBtn.addEventListener('click', () => {
    scanInputEl.value = '';
    scanClearBtn.hidden = true;
    scanInputEl.focus();
  });

  const debouncedSearch = debounce(runSearch, SEARCH_DEBOUNCE_MS);
  searchInputEl.addEventListener('input', () => debouncedSearch(searchInputEl.value));
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInputEl.value = '';
      runSearch('');
      scanInputEl.focus();
    }
  });

  function commitOnEnter(input, commit) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    });
    input.addEventListener('blur', commit);
  }
  commitOnEnter(discountInputEl, applyDiscountFromInput);
  commitOnEnter(taxInputEl, applyTaxFromInput);
  // Mark the field as the cashier's own the moment they type in it, so the
  // async hydrate cannot clobber a half-typed rate.
  taxInputEl.addEventListener('input', () => { taxEditedByUser = true; });

  // Payment method + amount received
  amountReceivedEl.addEventListener('input', () => renderPaymentSummary(cart.getState()));
  amountReceivedEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); renderPaymentSummary(cart.getState()); amountReceivedEl.blur(); }
  });
  payMethodRadios.forEach((r) => r.addEventListener('change', () => renderPaymentSummary(cart.getState())));

  // Click delegation
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const barcode = btn.dataset.barcode;

    if (action === 'add-result') {
      const product = productsCache.get(barcode);
      if (product) addProductToCart(product, 1);
      return;
    }
    if (action === 'inc' || action === 'dec') {
      const line = cart.findByBarcode(barcode);
      if (!line) return;
      const delta = action === 'inc' ? 1 : -1;
      // Quantity 0 means "remove the line" — see cart.setQuantity.
      try {
        cart.setQuantity(barcode, line.quantity + delta);
      } catch (err) {
        showToast(err.message, 'error');
      }
      refocusQtyControl(barcode, action);
      return;
    }
    if (action === 'remove') {
      cart.remove(barcode);
      return;
    }
    if (action === 'clear-cart') {
      const state = cart.getState();
      if (state.isEmpty) {
        showToast('Cart is already empty.');
        return;
      }
      if (confirm(`Clear ${state.itemCount} item${state.itemCount === 1 ? '' : 's'} from the cart?`)) {
        resetCartUi();
        showToast('Cart cleared.');
      }
      return;
    }
    if (action === 'checkout') {
      completeCheckout();
      return;
    }
    if (action === 'receipt-close') {
      closeReceiptModal();
      return;
    }
    if (action === 'receipt-close-and-clear') {
      closeReceiptModalAndClearCart();
    }
    if (action === 'receipt-print') {
      handlePrintReceipt();
    }
  });

  // Quantity inputs
  root.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches && el.matches('[data-role="qty"]')) el.select();
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches && el.matches('[data-role="qty"]')) applyQtyFromInput(el);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.matches && el.matches('[data-role="qty"]') && e.key === 'Enter') {
      e.preventDefault();
      const barcode = el.dataset.barcode;
      applyQtyFromInput(el);
      el.blur();
      // The repaint inside applyQtyFromInput replaced this input; keep the
      // caret where the cashier left it.
      refocusQtyControl(barcode, 'qty');
    }
  });

  // Global shortcuts: F2 → scan, F4 → search, F9 → checkout.
  document.addEventListener('keydown', viewShortcutHandler);
  function viewShortcutHandler(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target && e.target.matches && e.target.matches('input, textarea, select')) {
      // Don't override function keys from inside the cart's own inputs.
      // F2/F4 are still useful because the scan/search inputs already
      // consume them first, but we skip when typing in payment fields
      // to avoid surprise moves.
      if (e.target.matches('[data-role="amount-received"]')) return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      scanInputEl.focus();
      scanInputEl.select();
    } else if (e.key === 'F4') {
      e.preventDefault();
      searchInputEl.focus();
      searchInputEl.select();
    } else if (e.key === 'F9') {
      e.preventDefault();
      completeCheckout();
    }
  }

  // Pull tax-rate from settings (the main process returns the configured
  // value or the default if none has been set). We then hydrate the cart
  // and the tax input.
  async function hydrateTax() {
    const api = settingsApi();
    if (!api?.getStore) return;
    const res = await api.getStore();
    if (disposed) return;
    if (res.ok && res.data && Number.isFinite(Number(res.data.taxPercent))) {
      const pct = Number(res.data.taxPercent);
      storeTaxPercent = pct;
      // A rate the cashier already typed wins — this read can land after
      // they have started the next invoice.
      if (taxEditedByUser) return;
      taxInputEl.value = String(pct);
      cart.setTaxPercent(pct);
    }
  }

  // First paint
  mountedRoot = root;
  addByBarcode = addBarcodeToCart;
  catalogueReady = loadCatalogue();
  hydrateTax();
  // Wait one tick for the cart subscriber to receive its initial snapshot
  // before paint, so the invoice subtitle doesn't blink.
  queueMicrotask(() => { renderCart(cart.getState()); renderTotals(cart.getState()); renderPaymentSummary(cart.getState()); });
  scanInputEl.focus();

  // Teardown contract: the shell calls dispose() before the next view
  // replaces this DOM. Idempotent by design.
  function dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('keydown', viewShortcutHandler);
    debouncedSearch.cancel();
    clearTimeout(scanErrorTimer);
    clearTimeout(scanSuccessTimer);
    clearTimeout(scanFlashTimer);
    clearTimeout(showToast._t);
    showToast._t = null;
    cartUnsubscribe();
    if (mountedRoot === root) {
      mountedRoot = null;
      addByBarcode = null;
    }
  }

  return { el: root, dispose };
}
