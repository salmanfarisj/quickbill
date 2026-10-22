// QuickBill — Inventory view.
// Reads product rows from the database through the preload bridge and
// highlights anything at or below its minimum stock level.
//
// Money note: `products.cost_price` / `selling_price` are RUPEES stored in a
// REAL column. Everything displayed here is converted to integer PAISE once
// and formatted with the store profile, so this screen can never disagree
// with the till (billing), the receipts or the reports view — all of which
// work in integer paise.

import { formatCurrency } from '../lib/money.js';

const numFmt = new Intl.NumberFormat('en-IN');

// Rupees (DB REAL) → integer paise. Math.round here is the single documented
// rule for converting catalogue prices; the ledger itself never sees floats.
function toPaise(rupees) {
  return Math.round(Number(rupees || 0) * 100);
}

function formatInt(n) { return numFmt.format(Number(n) || 0); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let cachedProfile = null;
async function loadStoreProfile() {
  if (cachedProfile) return cachedProfile;
  try {
    const res = await window.quickbill.settings.getStore();
    if (res.ok && res.data) cachedProfile = res.data;
  } catch (_err) {
    // Fall through to the ₹/en-IN defaults baked into formatCurrency.
  }
  return cachedProfile;
}

function statCard(label, value, hint, kind = '') {
  return `
    <div class="stat">
      <div class="stat__label">${escapeHtml(label)}</div>
      <div class="stat__value">${escapeHtml(value)}</div>
      ${hint ? `<div class="stat__delta stat__delta--${kind}">${escapeHtml(hint)}</div>` : ''}
    </div>`;
}

function renderInventoryRow(p, profile) {
  const low = Number(p.stock_quantity) <= Number(p.min_stock_level);
  const deficit = Number(p.min_stock_level) - Number(p.stock_quantity);
  return `
    <tr class="${low ? 'row--low' : ''}">
      <td><code>${escapeHtml(p.sku)}</code></td>
      <td>${escapeHtml(p.name)}</td>
      <td><span class="pill pill--category">${escapeHtml(p.category)}</span></td>
      <td class="num"><strong>${formatInt(p.stock_quantity)}</strong></td>
      <td class="num">${formatInt(p.min_stock_level)}</td>
      <td class="num">${low ? `<span class="deficit">−${formatInt(deficit)}</span>` : '—'}</td>
      <td class="num">${escapeHtml(formatCurrency(toPaise(p.selling_price), profile))}</td>
      <td>${low ? '<span class="pill pill--low">Reorder now</span>' : '<span class="pill pill--ok">Healthy</span>'}</td>
    </tr>`;
}

function renderInventoryTable(rows, profile) {
  if (!rows.length) {
    return `
      <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">
        No products yet. Add some on the Products screen, or click
        <em>Add sample products</em> on the Products screen to populate a starter catalogue.
      </div>`;
  }
  const lowCount = rows.filter(p => Number(p.stock_quantity) <= Number(p.min_stock_level)).length;
  const totalUnits = rows.reduce((s, p) => s + Number(p.stock_quantity || 0), 0);
  // Integer paise all the way — the same arithmetic the reports view uses in
  // SQL. A float rupee sum here would drift and disagree with that figure.
  const inventoryValuePaise = rows.reduce(
    (s, p) => s + toPaise(p.cost_price) * Number(p.stock_quantity || 0), 0);

  const body = rows.map((p) => renderInventoryRow(p, profile)).join('');
  return `
    <div class="grid grid--stats" style="margin-bottom: 16px;">
      ${statCard('Total products', String(rows.length), '', 'flat')}
      ${statCard('Units in stock', formatInt(totalUnits), '', 'flat')}
      ${statCard('Inventory value', formatCurrency(inventoryValuePaise, profile), 'at cost', 'flat')}
      ${statCard('Low-stock items', String(lowCount), lowCount ? 'needs reorder' : 'all good', lowCount ? 'down' : 'up')}
    </div>

    <div class="card__body" style="padding: 0;">
      <table class="table">
        <thead>
          <tr>
            <th>SKU</th><th>Product</th><th>Category</th>
            <th class="num">In stock</th><th class="num">Reorder at</th>
            <th class="num">Shortfall</th><th class="num">Price</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderLowStockOnly(rows, profile) {
  const low = rows.filter(p => Number(p.stock_quantity) <= Number(p.min_stock_level));
  if (!low.length) {
    return `
      <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">
        Nothing is below its reorder threshold right now.
      </div>`;
  }
  const body = low.map((p) => renderInventoryRow(p, profile)).join('');
  return `
    <div class="card__body" style="padding: 0;">
      <table class="table">
        <thead>
          <tr>
            <th>SKU</th><th>Product</th><th>Category</th>
            <th class="num">In stock</th><th class="num">Reorder at</th>
            <th class="num">Shortfall</th><th class="num">Price</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

export function renderInventory() {
  const root = document.createElement('div');
  root.className = 'view view--inventory';

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Inventory</h1>
        <p>Stock levels across the catalogue. Items at or below their reorder threshold are highlighted.</p>
      </div>
      <div class="page-header__actions">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn btn--primary" data-action="goto-products">Manage products</button>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <div>
          <div class="card__title">Stock overview</div>
          <div class="card__subtitle">Live counts from the database</div>
        </div>
        <div class="tabs" role="tablist">
          <button class="tab is-active" data-tab="all" role="tab">All products</button>
          <button class="tab" data-tab="low" role="tab">Low-stock only <span class="tab__count" data-role="low-count">0</span></button>
        </div>
      </div>
      <div data-role="body">
        <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading inventory…</div>
      </div>
    </div>
  `;

  const bodyEl    = root.querySelector('[data-role="body"]');
  const lowCountEl = root.querySelector('[data-role="low-count"]');
  let activeTab = 'all';
  let rows = [];
  let disposed = false;
  let profile = cachedProfile;

  function paint() {
    // The shell may have detached this root while an IPC call was in flight.
    if (disposed || !bodyEl.isConnected) return;
    bodyEl.innerHTML = activeTab === 'low'
      ? renderLowStockOnly(rows, profile)
      : renderInventoryTable(rows, profile);
    const low = rows.filter(p => Number(p.stock_quantity) <= Number(p.min_stock_level)).length;
    lowCountEl.textContent = String(low);
  }

  async function refresh() {
    if (disposed || !bodyEl.isConnected) return;
    bodyEl.innerHTML = `<div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading inventory…</div>`;
    let list = null;
    try {
      const res = await window.quickbill.products.list({});
      if (disposed || !bodyEl.isConnected) return;
      if (!res.ok) {
        bodyEl.innerHTML = `<div class="card__body" style="text-align:center; color: var(--error); padding: 36px 18px;">Error: ${escapeHtml(res.error.message)}</div>`;
        return;
      }
      list = Array.isArray(res.data) ? res.data : [];
      profile = await loadStoreProfile();
    } catch (err) {
      if (disposed || !bodyEl.isConnected) return;
      bodyEl.innerHTML = `<div class="card__body" style="text-align:center; color: var(--error); padding: 36px 18px;">Error: ${escapeHtml(err?.message || 'Could not reach the database.')}</div>`;
      return;
    }
    rows = list;
    paint();
  }

  root.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      activeTab = tabBtn.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('is-active', b === tabBtn));
      paint();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'refresh') return refresh();
    // navigate() (not showView) so the URL stays in sync and a reload
    // restores this screen instead of dropping the cashier back.
    if (btn.dataset.action === 'goto-products') return window.__quickbill?.navigate?.('products');
  });

  refresh();

  return {
    el: root,
    dispose() { disposed = true; }
  };
}