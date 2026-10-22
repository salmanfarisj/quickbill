// QuickBill — Sales History view.
//
// Lists every invoice recorded by the main process, with date filters and
// free-text bill-number search. Clicking a row opens a full bill-detail
// modal showing items, totals, payment and change-due. Sales are
// read-only by design — there is no "edit sale" affordance on any screen;
// the only post-sale actions are View (reopen) and Print (reprint).
//
// The renderer never touches the database directly — every call goes
// through window.quickbill.sales / window.quickbill.receipt.

import { formatINR } from '../lib/money.js';
import { buildReceiptDocuments } from '../lib/receipt.js';
import { loadReceiptForSale, listPrinters, printSaleReceipt } from '../lib/print.js';
import { statusLabel, statusClass, saleTimestamp } from '../lib/format.js';

const salesApi = () => window.quickbill?.sales;

// How many invoices one query returns. The cap is enforced in the main
// process (listSales clamps LIMIT to 1000), so the list is truncated by
// design — the UI says so rather than silently hiding invoices.
const PAGE_LIMIT = 50;

// How much history "Load demo month" books. Kept in one place because it is
// quoted in the confirmation dialog as well as the IPC call.
const DEMO_SEED_DAYS = 30;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statusPill(status) {
  return `<span class="pill ${escapeHtml(statusClass(status))}">${escapeHtml(statusLabel(status))}</span>`;
}

function methodLabel(method, status) {
  if (method === 'cash') {
    if (status === 'partial') return 'Cash · partial';
    if (status === 'paid')    return 'Cash';
    return 'Cash · credit';
  }
  if (method === 'unpaid') return 'Credit';
  return escapeHtml(method || '');
}

// The shell's quick search dispatches `quickbill:quick-pick` AFTER it has
// navigated here, so this view is already mounted by the time the event
// arrives. Registered once at module scope (the module loads once per page,
// so it cannot leak); it bails out when the view is not the active one.
let activeView = null;
window.addEventListener('quickbill:quick-pick', async (e) => {
  const detail = e && e.detail;
  if (!detail || detail.kind !== 'sale') return;
  if (!activeView) return;
  await activeView.openBillNumber(detail.id);
});

export function renderSalesHistory() {
  const root = document.createElement('div');
  root.className = 'view view--sales-history';

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Sales History</h1>
        <p>Browse, filter and reopen any invoice. Click a row for full bill details including payment and change.</p>
      </div>
      <div class="page-header__actions">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn" data-action="seed-demo">Load demo month</button>
        <button class="btn btn--primary" data-action="goto-billing">New sale</button>
      </div>
    </div>

    <div class="card">
      <div class="card__header toolbar">
        <input class="input toolbar__search" type="search" data-role="q"
               placeholder="Search by bill number, cashier or customer…" aria-label="Search sales" />
        <input class="input toolbar__date" type="date" data-role="from" aria-label="From date" />
        <span class="toolbar__sep">→</span>
        <input class="input toolbar__date" type="date" data-role="to" aria-label="To date" />
        <button class="btn" data-action="clear-filters">Clear</button>
        <span class="toolbar__spacer"></span>
        <span class="toolbar__count" data-role="count">—</span>
      </div>

      <div class="card__body" style="padding: 0;" data-role="table">
        <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading sales…</div>
      </div>
    </div>

    <div class="modal" data-role="bill-modal" hidden></div>
    <div class="modal" data-role="seed-modal" hidden></div>
    <div class="toast" data-role="toast" hidden></div>
  `;

  const searchEl = root.querySelector('[data-role="q"]');
  const fromEl   = root.querySelector('[data-role="from"]');
  const toEl     = root.querySelector('[data-role="to"]');
  const countEl  = root.querySelector('[data-role="count"]');
  const tableEl  = root.querySelector('[data-role="table"]');
  const billModalEl = root.querySelector('[data-role="bill-modal"]');
  const seedModalEl = root.querySelector('[data-role="seed-modal"]');
  const toastEl  = root.querySelector('[data-role="toast"]');

  // Default to "today" as the from/to window so the list starts focused.
  fromEl.value = todayIso();
  toEl.value   = todayIso();

  let disposed = false;
  let searchTimer = null;
  let lastOpenedSale = null;
  let lastFocus = null;

  function isLive() { return !disposed && root.isConnected; }

  function showToast(message, kind = 'success') {
    toastEl.textContent = message;
    toastEl.className = `toast toast--${kind}`;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 2800);
  }

  function readFilters() {
    return {
      q:        String(searchEl.value || '').trim(),
      from:     String(fromEl.value   || '').trim(),
      to:       String(toEl.value     || '').trim(),
      limit:    PAGE_LIMIT
    };
  }

  async function refresh() {
    if (!isLive()) return;
    tableEl.innerHTML = `<div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading sales…</div>`;
    const res = await salesApi().list(readFilters());
    if (!isLive()) return;
    if (!res.ok) {
      tableEl.innerHTML = `<div class="card__body" style="text-align:center; color: var(--error); padding: 36px 18px;">Error: ${escapeHtml(res.error.message)}</div>`;
      countEl.textContent = '—';
      return;
    }
    paint(Array.isArray(res.data) ? res.data : []);
  }

  function paint(rows) {
    countEl.textContent = `${rows.length} sale${rows.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      tableEl.innerHTML = `
        <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">
          No sales match your filters yet.
        </div>`;
      return;
    }
    const body = rows.map(rowHtml).join('');
    // The list is capped at PAGE_LIMIT by the main process. When we hit the
    // cap we say so, instead of letting a shop with 300 invoices today
    // believe it only had 50.
    const truncated = rows.length >= PAGE_LIMIT
      ? `<div class="table__footer">Showing the first ${PAGE_LIMIT} invoices — narrow the date range or search to see the rest.</div>`
      : '';
    tableEl.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Bill</th>
            <th>Date</th>
            <th>Cashier</th>
            <th>Customer</th>
            <th class="num">Items</th>
            <th class="num">Total</th>
            <th>Method</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>${truncated}`;
  }

  function rowHtml(r) {
    const items = Number(r.item_count || 0);
    const id = escapeHtml(String(r.id));
    return `
      <tr data-id="${id}">
        <td><code>${escapeHtml(r.bill_number)}</code></td>
        <td>${escapeHtml(saleTimestamp(r))}</td>
        <td>${escapeHtml(r.cashier_name || '—')}</td>
        <td>${escapeHtml(r.customer_name || 'Walk-in')}</td>
        <td class="num">${escapeHtml(String(items))}</td>
        <td class="num"><strong>${formatINR(Number(r.total_paise))}</strong></td>
        <td>${escapeHtml(methodLabel(r.payment_method, r.payment_status))}</td>
        <td>${statusPill(r.payment_status)}</td>
        <td class="actions">
          <button class="btn btn--ghost" data-action="view" data-id="${id}">View</button>
        </td>
      </tr>`;
  }

  async function openBill(id) {
    const res = await salesApi().get(Number(id));
    if (!isLive()) return;
    if (!res.ok || !res.data) {
      showToast(`Could not load bill: ${res.error?.message || 'not found'}`, 'error');
      return;
    }
    renderBillModal(res.data);
  }

  // Quick-search entry point: the shell hands us a bill NUMBER, not an id.
  async function openBillNumber(billNumber) {
    const res = await salesApi().getByBill(String(billNumber || ''));
    if (!isLive()) return;
    if (!res.ok || !res.data) {
      showToast(`Could not open bill ${billNumber}: ${res.error?.message || 'not found'}`, 'error');
      return;
    }
    renderBillModal(res.data);
  }

  async function renderBillModal(sale) {
    lastOpenedSale = sale;
    billModalEl.innerHTML = `
      <div class="modal__backdrop" data-action="bill-close"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__header">
          <h2>Bill ${escapeHtml(sale.bill_number || '')}</h2>
          <button class="btn btn--ghost" data-action="bill-close" aria-label="Close">✕</button>
        </div>
        <div class="modal__body" data-role="bill-body">
          <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading receipt…</div>
        </div>
        <div class="form-actions" style="padding: 0 20px 20px; gap: 12px;">
          <select class="input" data-role="printer-select" style="max-width: 220px;">
            <option value="">Default printer</option>
          </select>
          <button type="button" class="btn" data-action="bill-print">Print receipt</button>
          <span style="flex:1"></span>
          <button type="button" class="btn btn--primary" data-action="bill-close">Close</button>
        </div>
      </div>`;
    billModalEl.hidden = false;
    // Remember what had focus so closing the modal returns the cashier to
    // the row they opened rather than stranding focus on <body>.
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyEl = billModalEl.querySelector('[data-role="bill-body"]');
    const selectEl = billModalEl.querySelector('[data-role="printer-select"]');
    billModalEl.querySelector('[data-action="bill-close"]')?.focus();
    listPrinters().then((pr) => {
      if (!pr.ok || !(pr.data?.printers || []).length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No printers detected';
        selectEl.appendChild(opt);
        selectEl.disabled = true;
        return;
      }
      for (const p of pr.data.printers) {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.displayName && p.displayName !== p.name
          ? `${p.name} — ${p.displayName}`
          : p.name;
        selectEl.appendChild(o);
      }
    }).catch(() => { /* error surfaces via Print click */ });

    const res = await loadReceiptForSale(sale.id);
    if (!isLive()) return;
    if (!res.ok) {
      bodyEl.innerHTML = `
        <div class="pos-banner pos-banner--error" role="alert">
          ${escapeHtml(res.message || 'Could not load receipt.')}
        </div>
        <p class="muted" style="margin-top: 12px;">
          Bill <code>${escapeHtml(String(sale.id))}</code> is still on disk — try refreshing this view.
        </p>`;
      return;
    }
    const docs = buildReceiptDocuments(res.data);
    bodyEl.innerHTML = docs.html;
  }

  async function handlePrintBill() {
    if (!lastOpenedSale) return;
    const selectEl = billModalEl.querySelector('[data-role="printer-select"]');
    const printer = selectEl ? String(selectEl.value || '') : '';
    const r = await printSaleReceipt(lastOpenedSale.id, { printer, copies: 1 });
    if (!isLive()) return;
    if (r.ok) {
      showToast('Receipt sent to the printer.');
      return;
    }
    if (r.code === 'PRINTER_CANCELLED') {
      showToast('Print cancelled.');
      return;
    }
    showToast(r.message || 'Printing failed.', 'error');
  }

  function closeBillModal() {
    billModalEl.hidden = true;
    billModalEl.innerHTML = '';
    lastOpenedSale = null;
    // Return focus to whatever opened the modal so keyboard users are not
    // dropped back at the top of the document.
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    lastFocus = null;
  }

  // ---- Demo month -------------------------------------------------------
  //
  // Seeding writes real rows into an append-only ledger, so it is confirmed
  // first and the dialog says plainly what will change — invoices created,
  // stock adjusted — rather than hiding behind a generic "are you sure?".

  function openSeedModal() {
    seedModalEl.innerHTML = `
      <div class="modal__backdrop" data-action="seed-close"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__header">
          <h2>Load a month of demo sales?</h2>
          <button class="btn btn--ghost" data-action="seed-close" aria-label="Close">✕</button>
        </div>
        <div class="modal__body">
          <p>This fills Sales History, the Dashboard and Reports with
             <strong>30 days</strong> of sample invoices — varied baskets,
             cash and credit, discounts and tax, spread across opening hours.</p>
          <p class="muted">Stock levels are topped up first so a month of
             trading never fails on an out-of-stock item. Running it again
             fills only the days that are still missing, so it is safe to
             repeat after new days pass.</p>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="seed-close">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="seed-run">Load demo month</button>
        </div>
      </div>`;
    seedModalEl.hidden = false;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    seedModalEl.querySelector('[data-action="seed-run"]')?.focus();
  }

  function closeSeedModal() {
    seedModalEl.hidden = true;
    seedModalEl.innerHTML = '';
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    lastFocus = null;
  }

  async function handleSeedDemo(runBtn) {
    let res;
    try {
      res = await salesApi().seedDemo({ days: DEMO_SEED_DAYS });
    } catch (err) {
      // The bridge is supposed to always resolve, but a rejected promise here
      // would otherwise strand the modal with a dead "Loading…" button.
      res = { ok: false, error: { message: err?.message || 'Could not reach the database.' } };
    } finally {
      // Always hand the button back, whatever happened.
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Load demo month'; }
    }
    if (!isLive()) return;
    if (!res.ok) {
      showToast(res.error?.message || 'Could not load the demo month.', 'error');
      return;
    }
    const { inserted = 0, replayed = 0, from = '', to = '', restocked = 0 } = res.data || {};
    closeSeedModal();
    if (inserted === 0) {
      showToast('Demo history is already up to date — nothing new to add.');
      return;
    }
    showToast(
      `Added ${inserted} demo invoice${inserted === 1 ? '' : 's'}` +
      `${replayed ? ` (${replayed} already existed)` : ''}.`
    );
    // Widen the filter to the range that was just filled — otherwise the list
    // stays pinned to today and the seeded month looks like it vanished.
    // Only when something was actually added: on a no-op run the seeder
    // reports the single day it already covers, and narrowing the filter to
    // that day would scroll the rest of the month out of view.
    if (inserted > 0) {
      if (from) fromEl.value = from;
      if (to)   toEl.value   = to;
    }
    await refresh();
    // The low-stock badge on the sidebar counts real rows; seeding moved it.
    if (restocked) window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
  }

  // Escape closes whichever modal is open. They are `position: fixed; inset: 0`,
  // so without this the only way out is the ✕ button — a trap if the receipt
  // fetch is slow or fails.
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!seedModalEl.hidden) { e.preventDefault(); closeSeedModal(); return; }
    if (billModalEl.hidden) return;
    e.preventDefault();
    closeBillModal();
  }
  document.addEventListener('keydown', onKeydown);

  // Event wiring
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 180);
  });
  fromEl.addEventListener('change', refresh);
  toEl.addEventListener('change', refresh);

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'refresh') return refresh();
    if (action === 'clear-filters') {
      searchEl.value = '';
      fromEl.value = todayIso();
      toEl.value = todayIso();
      refresh();
      return;
    }
    if (action === 'goto-billing') {
      // navigate() (not showView) so the URL stays in sync.
      if (window.__quickbill?.navigate) window.__quickbill.navigate('billing');
      return;
    }
    if (action === 'view') {
      openBill(btn.dataset.id);
      return;
    }
    if (action === 'seed-demo') {
      openSeedModal();
      return;
    }
    if (action === 'seed-close') {
      closeSeedModal();
      return;
    }
    if (action === 'seed-run') {
      // Disable the confirm button for the duration: seeding books hundreds
      // of invoices synchronously, and a double-click would fire a second
      // IPC call while the first is still running. handleSeedDemo always
      // restores it, including on failure.
      btn.disabled = true;
      btn.textContent = 'Loading…';
      await handleSeedDemo(btn);
      return;
    }
    if (action === 'bill-close') {
      closeBillModal();
    }
    if (action === 'bill-print') {
      handlePrintBill();
    }
  });

  // Published so the shell's quick-pick listener can reach this mount; the
  // module-scope listener above reads it (and is a no-op when null).
  activeView = { openBillNumber };

  // The shell invokes render() synchronously, then attaches `root` to
  // #content. Calling refresh() here in the same synchronous block would
  // run before `root.isConnected` is true, so isLive() would bail and the
  // table would stay stuck on "Loading sales…" until the user manually
  // changed a filter. Defer to a microtask so the shell has finished its
  // replaceChildren() call before refresh checks liveness.
  if (root.isConnected) refresh();
  else queueMicrotask(refresh);

  return {
    el: root,
    dispose() {
      if (disposed) return;
      disposed = true;
      activeView = null;
      document.removeEventListener('keydown', onKeydown);
      // Drop pending timers so nothing resolves against a detached tree.
      clearTimeout(searchTimer);
      clearTimeout(showToast._t);
      // Clear the seed modal's markup and the stashed focus target: `root` is
      // about to be detached, and a retained reference could resurrect focus
      // onto a button the user has already navigated away from.
      seedModalEl.innerHTML = '';
      seedModalEl.hidden = true;
      lastFocus = null;
    }
  };
}
