// QuickBill — front-end controller.
//
// Single-page shell: owns sidebar navigation, the topbar quick search and
// the live low-stock badge, and mounts exactly one view at a time.
//
// VIEW LIFECYCLE (the contract every view must honour)
// ---------------------------------------------------------------------------
// `showView()` calls `replaceChildren()` on #content, which detaches the
// previous view's DOM. Any view that registers a listener on `window`,
// `document` or a parent element OUTSIDE its own root — or that owns a
// timer — must therefore return a teardown handle so the shell can clean it
// up, otherwise every navigation leaks another handler that keeps firing
// against detached DOM.
//
// A view may therefore return either:
//   Element                      — no teardown needed (pure DOM)
//   { el: Element, dispose(){} } — preferred for anything that allocates
//                                  listeners, timers or observers
//
// `dispose()` must be idempotent: the shell calls it exactly once per mount,
// before the next view replaces the DOM.
//
// DATA CHANGES
// ---------------------------------------------------------------------------
// Views signal a mutation with `window.dispatchEvent(new CustomEvent(
// 'quickbill:data-changed'))`. That listener lives here, in the shell, so it
// is registered exactly once for the lifetime of the window.

import { renderDashboard } from './views/dashboard.js';
import { renderBilling }  from './views/billing.js';
import { renderProducts } from './views/products.js';
import { renderInventory } from './views/inventory.js';
import { renderSalesHistory } from './views/sales-history.js';
import { renderReports }  from './views/reports.js';
import { renderSettings } from './views/settings.js';
import { formatCurrencyValue } from './lib/money.js';

const VIEWS = {
  'dashboard':     { title: 'Dashboard',     subtitle: 'Overview of today’s activity', render: renderDashboard    },
  'billing':       { title: 'Billing',       subtitle: 'Create a new invoice',          render: renderBilling      },
  'products':      { title: 'Products',      subtitle: 'Catalogue of SKUs',             render: renderProducts     },
  'inventory':     { title: 'Inventory',     subtitle: 'Stock levels & adjustments',    render: renderInventory    },
  'sales-history': { title: 'Sales History', subtitle: 'Past transactions',             render: renderSalesHistory },
  'reports':       { title: 'Reports',       subtitle: 'Sales & performance insights',  render: renderReports      },
  'settings':      { title: 'Settings',      subtitle: 'Store preferences & devices',   render: renderSettings     }
};

const DEFAULT_VIEW = 'dashboard';
const QUICK_SEARCH_MIN = 2;
const QUICK_SEARCH_DEBOUNCE_MS = 160;
const QUICK_SEARCH_LIMIT = 6;

// The currently mounted view's teardown handle, or null for a plain Element.
let activeDispose = null;

function getInitialView() {
  // Reads ?view=foo from the URL; falls back to dashboard.
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('view');
  return VIEWS[requested] ? requested : DEFAULT_VIEW;
}

function setActiveNav(viewName) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === viewName);
  });
}

function setTopbar(view) {
  const titleEl = document.getElementById('topbarTitle');
  const crumbEl = document.getElementById('topbarCrumb');
  if (titleEl) titleEl.textContent = view.title;
  if (crumbEl)  crumbEl.textContent = view.subtitle;
}

function showView(viewName) {
  const view = VIEWS[viewName] || VIEWS[DEFAULT_VIEW];
  const slot = document.getElementById('content');
  if (!slot) return;

  // Tear the outgoing view down BEFORE its DOM is detached so dispose()
  // can still reach its elements.
  if (typeof activeDispose === 'function') {
    try { activeDispose(); } catch (err) { console.error('[quickbill] view dispose failed', err); }
  }
  activeDispose = null;

  const mounted = view.render();
  const el = (mounted && typeof mounted === 'object' && mounted.el) ? mounted.el : mounted;
  if (mounted && typeof mounted === 'object' && typeof mounted.dispose === 'function') {
    activeDispose = mounted.dispose;
  }
  if (!el) {
    console.error(`[quickbill] view "${viewName}" returned no element`);
    return;
  }

  setActiveNav(viewName);
  setTopbar(view);
  slot.replaceChildren(el);
  document.title = `${view.title} — QuickBill`;
}

// Navigate AND keep the URL in sync. Every in-app jump must go through this
// so a reload (or Cmd+R in dev) restores the same screen.
function navigate(viewName) {
  if (!VIEWS[viewName]) return;
  let url;
  try {
    url = new URL(window.location.href);
  } catch (_err) {
    // `file://` URLs with no query can reject URL parsing in some builds;
    // falling back to a direct mount keeps navigation working either way.
    showView(viewName);
    return;
  }
  url.searchParams.set('view', viewName);
  try {
    window.history.replaceState({}, '', url.toString());
  } catch (_err) {
    // History is unavailable for this origin — navigation still works.
  }
  showView(viewName);
}

// Live low-stock badge — pulls the latest number from the DB so the sidebar
// stays in sync with whatever the products view did.
async function refreshLowStockBadge() {
  const badge = document.getElementById('lowStockBadge');
  if (!badge || !window.quickbill?.products?.countLowStock) return;
  const res = await window.quickbill.products.countLowStock();
  if (!res.ok) return;
  const n = Number(res.data) || 0;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view;
      if (!next || !VIEWS[next]) return;
      navigate(next);
    });
  });
}

// ---------------------------------------------------------------------------
// Topbar quick search
//
// One search box across the whole app: catalogue products AND invoices.
// Owned entirely by the shell, so it has a single lifetime and never needs
// teardown. Results are dispatched as a `quickbill:quick-pick` window event
// AFTER navigation, so the destination view is already mounted when it
// receives the event.
// ---------------------------------------------------------------------------

const quickSearch = {
  input: null,
  panel: null,
  results: null,
  timer: null,
  token: 0,
  profile: null
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function hideQuickSearch() {
  if (quickSearch.panel) quickSearch.panel.hidden = true;
  quickSearch.input?.removeAttribute('aria-expanded');
}

function renderQuickSearchStatus(message) {
  if (!quickSearch.results) return;
  quickSearch.results.innerHTML = `<div class="qs__status">${escapeHtml(message)}</div>`;
  if (quickSearch.panel) quickSearch.panel.hidden = false;
}

async function loadQuickSearchProfile() {
  if (quickSearch.profile) return quickSearch.profile;
  const res = await window.quickbill.settings.getStore();
  quickSearch.profile = res.ok ? res.data : null;
  return quickSearch.profile;
}

async function runQuickSearch(term) {
  const q = String(term || '').trim();
  if (q.length < QUICK_SEARCH_MIN) {
    quickSearch.token++;            // invalidate any in-flight search
    hideQuickSearch();
    return;
  }
  const token = ++quickSearch.token;
  renderQuickSearchStatus('Searching…');
  try {
    const [productsRes, salesRes] = await Promise.all([
      window.quickbill.products.list({ search: q }),
      window.quickbill.sales.list({ q, limit: QUICK_SEARCH_LIMIT })
    ]);
    if (token !== quickSearch.token) return;   // a newer keystroke won

    const products = productsRes.ok && Array.isArray(productsRes.data) ? productsRes.data : [];
    const sales = salesRes.ok && Array.isArray(salesRes.data) ? salesRes.data : [];
    const profile = productsRes.ok ? await loadQuickSearchProfile() : null;

    if (!products.length && !sales.length) {
      renderQuickSearchStatus(`No products or invoices match “${q}”.`);
      return;
    }

    const parts = [];
    if (products.length) {
      parts.push(`<div class="qs__group-title">Products (${products.length}${products.length === QUICK_SEARCH_LIMIT ? '+' : ''})</div>`);
      parts.push(`<ul class="qs__list">${products.slice(0, QUICK_SEARCH_LIMIT).map((p) => `
        <li>
          <button type="button" class="qs__item" data-kind="product" data-id="${escapeHtml(p.barcode)}">
            <span class="qs__item-main">
              <span class="qs__item-title">${escapeHtml(p.name)}</span>
              <span class="qs__item-meta">${escapeHtml(p.sku)} · ${escapeHtml(p.barcode)}</span>
            </span>
            <span class="qs__item-side">
              <span class="qs__item-price">${escapeHtml(formatCurrencyValue(Math.round(Number(p.selling_price || 0) * 100), profile))}</span>
              <span class="qs__item-meta">${escapeHtml(p.stock_quantity)} in stock</span>
            </span>
          </button>
        </li>`).join('')}</ul>`);
    }
    if (sales.length) {
      parts.push(`<div class="qs__group-title">Invoices (${sales.length}${sales.length === QUICK_SEARCH_LIMIT ? '+' : ''})</div>`);
      parts.push(`<ul class="qs__list">${sales.slice(0, QUICK_SEARCH_LIMIT).map((s) => `
        <li>
          <button type="button" class="qs__item" data-kind="sale" data-id="${escapeHtml(s.bill_number)}">
            <span class="qs__item-main">
              <span class="qs__item-title">${escapeHtml(s.bill_number)}</span>
              <span class="qs__item-meta">${escapeHtml(s.created_at_local || '')}${s.customer_name ? ` · ${escapeHtml(s.customer_name)}` : ''}</span>
            </span>
            <span class="qs__item-side">
              <span class="qs__item-price">${escapeHtml(formatCurrencyValue(Number(s.total_paise || 0), profile))}</span>
              <span class="qs__item-meta">${escapeHtml(String(s.payment_status || ''))}</span>
            </span>
          </button>
        </li>`).join('')}</ul>`);
    }
    quickSearch.results.innerHTML = parts.join('');
    if (quickSearch.panel) quickSearch.panel.hidden = false;
    quickSearch.input?.setAttribute('aria-expanded', 'true');
  } catch (err) {
    if (token !== quickSearch.token) return;
    renderQuickSearchStatus('Search is unavailable right now.');
    console.error('[quickbill] quick search failed', err);
  }
}

function bindQuickSearch() {
  const input = document.getElementById('topbarSearch');
  if (!input) return;
  const panel = document.createElement('div');
  panel.className = 'qs';
  panel.hidden = true;
  panel.innerHTML = '<div class="qs__results" role="listbox" aria-label="Quick search results"></div>';
  document.body.appendChild(panel);

  quickSearch.input = input;
  quickSearch.panel = panel;
  quickSearch.results = panel.querySelector('.qs__results');

  input.addEventListener('input', () => {
    clearTimeout(quickSearch.timer);
    const value = input.value;
    quickSearch.timer = setTimeout(() => runQuickSearch(value), QUICK_SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideQuickSearch();
      input.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = quickSearch.results?.querySelector('.qs__item');
      if (first) first.click();
    }
  });

  // Click a result: navigate first, THEN dispatch — the destination view is
  // mounted by the time it listens.
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.qs__item');
    if (!btn) return;
    const kind = btn.dataset.kind;
    const id = btn.dataset.id;
    hideQuickSearch();
    input.value = '';
    input.blur();
    if (kind === 'product') {
      navigate('billing');
      window.dispatchEvent(new CustomEvent('quickbill:quick-pick', { detail: { kind: 'product', id } }));
    } else if (kind === 'sale') {
      navigate('sales-history');
      window.dispatchEvent(new CustomEvent('quickbill:quick-pick', { detail: { kind: 'sale', id } }));
    }
  });

  // Click-away + Cmd/Ctrl+K.
  document.addEventListener('pointerdown', (e) => {
    if (panel.contains(e.target) || input.contains(e.target)) return;
    hideQuickSearch();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// Cashier identity shown in the topbar. Billing reads it from here so the
// ledger and the header can never disagree about who rang the sale up.
function currentCashierName() {
  const el = document.getElementById('topbarUserName');
  const name = el ? el.textContent.trim() : '';
  return name || 'Cashier';
}

function init() {
  bindNav();
  bindQuickSearch();
  showView(getInitialView());
  refreshLowStockBadge();

  const versionEl = document.getElementById('sidebarVersion');
  const version = window.quickbill?.app?.version;
  if (versionEl && version) versionEl.textContent = `QuickBill POS ${version}`;

  // Products view dispatches this after add/edit/delete; keep the badge fresh.
  window.addEventListener('quickbill:data-changed', refreshLowStockBadge);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Debug/test seam. Read-only plus navigation; no mutation API and no Node
// access is exposed from here.
window.__quickbill = {
  showView,
  navigate,
  currentCashierName,
  refreshLowStockBadge,
  getView: () => getInitialView()
};