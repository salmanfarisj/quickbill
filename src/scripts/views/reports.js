// QuickBill — Reports view, Phase 5.
//
// All numbers come from the persistent sales ledger and products table
// via the contextBridge — no demo data. The view exposes:
//
//   • Sales summary with date range picker (count, totals, paid/unpaid/
//     partial, avg ticket, change due)
//   • Low-stock report (items at or below reorder level)
//   • Inventory valuation (cost + retail value, by category and per item)
//
// Loading / empty / error states are drawn explicitly. All currency
// values are rendered with the configured store profile.

import { formatCurrency } from '../lib/money.js';

const reportsApi  = () => window.quickbill?.reports;
const settingsApi = () => window.quickbill?.settings;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthStartIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

function fmtMoney(paise, profile) {
  return formatCurrency(paise || 0, profile);
}

function loadingState(message = 'Loading…') {
  return `<div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">${escapeHtml(message)}</div>`;
}
function emptyState(message, kind = 'soft') {
  return `<div class="pos-empty pos-empty--${kind}">${escapeHtml(message)}</div>`;
}
function errorState(message) {
  return `<div class="card__body" style="text-align:center; color: var(--error); padding: 24px 18px;">${escapeHtml(message || 'Could not load the report.')}</div>`;
}

export function renderReports() {
  const root = document.createElement('div');
  root.className = 'view view--reports';
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Reports</h1>
        <p>Sales window, low-stock alerts and inventory valuation. Every figure comes from the database.</p>
      </div>
      <div class="page-header__actions" style="display:flex; gap:8px; align-items:center;">
        <label class="muted" style="font-size: 12px;">From</label>
        <input class="input" type="date" data-role="from" />
        <label class="muted" style="font-size: 12px;">To</label>
        <input class="input" type="date" data-role="to" />
        <button class="btn" data-action="range-today">Today</button>
        <button class="btn" data-action="range-month">This month</button>
        <button class="btn btn--primary" data-action="refresh">Refresh</button>
      </div>
    </div>

    <div id="reportsState"></div>

    <div class="grid grid--two">
      <div class="card" style="grid-column: 1 / -1;">
        <div class="card__header">
          <div>
            <div class="card__title">Sales summary</div>
            <div class="card__subtitle" data-role="summary-subtitle">—</div>
          </div>
        </div>
        <div class="card__body" data-role="summary">${loadingState('Loading sales summary…')}</div>
      </div>

      <div class="card">
        <div class="card__header">
          <div>
            <div class="card__title">Low-stock items</div>
            <div class="card__subtitle">Items at or below their reorder level.</div>
          </div>
        </div>
        <div class="card__body" style="padding: 0;" data-role="low-stock">${loadingState('Loading low-stock report…')}</div>
      </div>

      <div class="card">
        <div class="card__header">
          <div>
            <div class="card__title">Inventory valuation</div>
            <div class="card__subtitle">Cost vs retail across the catalogue.</div>
          </div>
        </div>
        <div class="card__body" data-role="valuation">${loadingState('Loading inventory valuation…')}</div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div class="card__header">
          <div>
            <div class="card__title">Inventory breakdown by category</div>
            <div class="card__subtitle">Cost × current stock vs. retail × current stock.</div>
          </div>
        </div>
        <div class="card__body" style="padding: 0;" data-role="category">${loadingState('Loading category breakdown…')}</div>
      </div>
    </div>
  `;

  const stateEl = root.querySelector('#reportsState');
  const fromEl  = root.querySelector('[data-role="from"]');
  const toEl    = root.querySelector('[data-role="to"]');
  const summaryEl = root.querySelector('[data-role="summary"]');
  const summarySubEl = root.querySelector('[data-role="summary-subtitle"]');
  const lowStockEl = root.querySelector('[data-role="low-stock"]');
  const valuationEl = root.querySelector('[data-role="valuation"]');
  const categoryEl = root.querySelector('[data-role="category"]');

  let profile = null;
  let timer = null;

  async function loadProfile() {
    if (!settingsApi()?.getStore) return;
    const res = await settingsApi().getStore();
    if (res.ok) profile = res.data;
  }

  function summaryCards(summary) {
    const cards = [
      { label: 'Bills',         value: String(summary.saleCount) },
      { label: 'Total revenue', value: fmtMoney(summary.totalPaise, profile) },
      { label: 'Tax collected', value: fmtMoney(summary.taxPaise,   profile) },
      { label: 'Discounts',     value: fmtMoney(summary.discountPaise, profile) },
      { label: 'Average ticket',value: fmtMoney(summary.avgTicketPaise, profile) },
      { label: 'Change issued', value: fmtMoney(summary.changeDuePaise, profile) }
    ];
    return `<div class="grid grid--stats" style="margin-bottom: 16px;">
      ${cards.map((c) => `<div class="stat">
        <div class="stat__label">${escapeHtml(c.label)}</div>
        <div class="stat__value">${escapeHtml(c.value)}</div>
      </div>`).join('')}
    </div>`;
  }

  function paymentBreakdown(summary) {
    const total = Math.max(1, summary.totalPaise);
    const rows = [
      { label: 'Paid',    paise: summary.paidPaise,    cls: 'pill--paid' },
      { label: 'Partial', paise: summary.partialPaise, cls: 'pill--pending' },
      { label: 'Unpaid (credit)', paise: summary.unpaidPaise, cls: 'pill--unpaid' }
    ];
    return `
      <div class="grid grid--two" style="margin-bottom: 8px;">
        <div>
          <h3 style="margin: 0 0 8px; font-size: 13px; color: var(--muted);">Payment breakdown</h3>
          <table class="table">
            <thead><tr><th>Status</th><th class="num">Total</th><th class="num">Share</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td><span class="pill ${r.cls}">${escapeHtml(r.label)}</span></td>
                  <td class="num">${escapeHtml(fmtMoney(r.paise, profile))}</td>
                  <td class="num">${escapeHtml(((Number(r.paise || 0) / total) * 100).toFixed(1))}%</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div>
          <h3 style="margin: 0 0 8px; font-size: 13px; color: var(--muted);">Window</h3>
          <table class="table">
            <tbody>
              <tr><td>First sale</td><td class="num">${escapeHtml(summary.firstSaleAt || '—')}</td></tr>
              <tr><td>Last sale</td><td class="num">${escapeHtml(summary.lastSaleAt || '—')}</td></tr>
              <tr><td>Cash received</td><td class="num">${escapeHtml(fmtMoney(summary.amountReceivedPaise, profile))}</td></tr>
              <tr><td>Change issued</td><td class="num">${escapeHtml(fmtMoney(summary.changeDuePaise, profile))}</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
  }

  async function refreshSummary() {
    const filters = { from: fromEl.value || '', to: toEl.value || '' };
    const r = await reportsApi().salesSummary(filters);
    if (!r.ok) {
      summaryEl.innerHTML = errorState(r.error?.message || 'Could not load sales summary.');
      return;
    }
    const summary = r.data;
    summarySubEl.textContent = `Window: ${summary.from || 'all-time'} → ${summary.to || 'all-time'}`;
    if (summary.saleCount === 0) {
      summaryEl.innerHTML = emptyState('No sales were recorded in this window. Widen the dates or complete a sale.', 'soft');
      return;
    }
    summaryEl.innerHTML = summaryCards(summary) + paymentBreakdown(summary);
  }

  async function refreshLowStock() {
    const r = await reportsApi().lowStock();
    if (!r.ok) {
      lowStockEl.innerHTML = errorState(r.error?.message || 'Could not load low-stock report.');
      return;
    }
    const rows = r.data || [];
    if (rows.length === 0) {
      lowStockEl.innerHTML = emptyState('Inventory is healthy — nothing below the reorder threshold.', 'soft');
      return;
    }
    const body = rows.map((p) => {
      const deficit = Math.max(0, Number(p.min_stock_level || 0) - Number(p.stock_quantity || 0));
      return `<tr class="${Number(p.stock_quantity) <= Number(p.min_stock_level) ? 'row--low' : ''}">
        <td><code>${escapeHtml(p.sku)}</code></td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category)}</td>
        <td class="num"><strong>${escapeHtml(String(p.stock_quantity))}</strong></td>
        <td class="num">${escapeHtml(String(p.min_stock_level))}</td>
        <td class="num">${deficit > 0 ? `<span class="deficit">−${escapeHtml(String(deficit))}</span>` : '—'}</td>
        <td><span class="pill pill--low">Reorder now</span></td>
      </tr>`;
    }).join('');
    lowStockEl.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>SKU</th><th>Product</th><th>Category</th>
          <th class="num">In stock</th><th class="num">Reorder at</th>
          <th class="num">Shortfall</th><th>Status</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  async function refreshValuation() {
    const r = await reportsApi().inventoryValuation();
    if (!r.ok) {
      valuationEl.innerHTML = errorState(r.error?.message || 'Could not load inventory valuation.');
      categoryEl.innerHTML = '';
      return;
    }
    const v = r.data;
    if (!v.productCount) {
      valuationEl.innerHTML = emptyState('No products yet — add inventory on the Products screen to value stock.', 'soft');
      categoryEl.innerHTML = '';
      return;
    }
    valuationEl.innerHTML = `
      <div class="grid grid--stats" style="margin-bottom: 12px;">
        <div class="stat"><div class="stat__label">SKUs</div><div class="stat__value">${v.productCount}</div></div>
        <div class="stat"><div class="stat__label">Units in stock</div><div class="stat__value">${v.totalUnits}</div></div>
        <div class="stat"><div class="stat__label">Cost value</div><div class="stat__value">${escapeHtml(fmtMoney(v.totalCostValuePaise, profile))}</div></div>
        <div class="stat"><div class="stat__label">Retail value</div><div class="stat__value">${escapeHtml(fmtMoney(v.totalRetailValuePaise, profile))}</div></div>
      </div>
      ${v.lowStockCount ? `<p class="muted" style="margin: 0; font-size: 12.5px;">
        <strong style="color: var(--error);">${v.lowStockCount}</strong> low-stock item${v.lowStockCount === 1 ? '' : 's'}.
        See the table on the left for reorder hints.
      </p>` : ''}
    `;
    if (!v.byCategory.length) {
      categoryEl.innerHTML = emptyState('No categories yet.', 'soft');
      return;
    }
    const max = Math.max(1, ...v.byCategory.map(c => c.retailValuePaise));
    const body = v.byCategory.map((c) => `
      <tr>
        <td>${escapeHtml(c.category)}</td>
        <td class="num">${escapeHtml(String(c.productCount))}</td>
        <td class="num">${escapeHtml(String(c.units))}</td>
        <td class="num">${escapeHtml(fmtMoney(c.costValuePaise, profile))}</td>
        <td class="num"><strong>${escapeHtml(fmtMoney(c.retailValuePaise, profile))}</strong></td>
        <td class="bar-cell">
          <div class="bar-row__track" style="margin-left: 6px;">
            <div class="bar-row__fill" style="width: ${(c.retailValuePaise / max * 100).toFixed(1)}%;"></div>
          </div>
        </td>
      </tr>`).join('');
    categoryEl.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>Category</th>
          <th class="num">SKUs</th>
          <th class="num">Units</th>
          <th class="num">Cost value</th>
          <th class="num">Retail value</th>
          <th>Share</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  async function refreshAll() {
    stateEl.innerHTML = `<div class="banner banner--loading" role="status">Refreshing reports…</div>`;
    try {
      await Promise.all([refreshSummary(), refreshLowStock(), refreshValuation()]);
      stateEl.innerHTML = '';
    } catch (e) {
      stateEl.innerHTML = `<div class="banner banner--error" role="status">${escapeHtml(e?.message || 'Could not refresh reports.')}</div>`;
    }
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refreshAll, 200);
  }

  fromEl.value = monthStartIso();
  toEl.value   = todayIso();

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'refresh') return refreshAll();
    if (btn.dataset.action === 'range-today') {
      fromEl.value = todayIso();
      toEl.value   = todayIso();
      refreshAll();
    }
    if (btn.dataset.action === 'range-month') {
      fromEl.value = monthStartIso();
      toEl.value   = todayIso();
      refreshAll();
    }
  });
  fromEl.addEventListener('change', refreshAll);
  toEl.addEventListener('change', refreshAll);

  // Registered on `window`, so they MUST be released through the shell's
  // teardown contract: without it every visit to Reports leaves another
  // live handler bound to a detached DOM tree.
  function onDataChanged() { scheduleRefresh(); }
  async function onSettingsUpdated() {
    await loadProfile();
    scheduleRefresh();
  }
  window.addEventListener('quickbill:data-changed', onDataChanged);
  window.addEventListener('quickbill:settings-updated', onSettingsUpdated);

  loadProfile().then(refreshAll);

  return {
    el: root,
    dispose() {
      window.removeEventListener('quickbill:data-changed', onDataChanged);
      window.removeEventListener('quickbill:settings-updated', onSettingsUpdated);
      // Cancel the pending debounce so refreshAll() cannot run against a
      // detached tree after navigation.
      clearTimeout(timer);
    }
  };
}
