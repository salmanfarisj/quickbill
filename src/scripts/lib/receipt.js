// QuickBill — receipt renderer (Phase 5).
//
// Renders a printable receipt from a sale shape returned by the main
// process (`getReceiptProfile`). The output is intentionally plain HTML
// with inline CSS so it works in:
//   - the in-app receipt modal (warm, boxed styling)
//   - the print-friendly document (loaded into a hidden BrowserWindow
//     with the system print dialog)
//
// Money formatting uses the store profile's currency/locale; the
// renderer-side money helpers (`formatCurrency`) fail safe to en-IN/₹
// so a malformed profile never produces NaN on a receipt.
//
// Historical integrity: every value displayed comes from the persisted
// `sales` and `sale_items` rows plus the store profile — nothing is
// recomputed or interpolated. The print pipeline never mutates the
// sale, the stock, or any historical record.

import { formatCurrency, formatCurrencyValue } from './money.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function methodLabel(method, status) {
  if (method === 'cash') {
    if (status === 'partial') return 'Cash · partial';
    if (status === 'paid')    return 'Cash';
    return 'Cash · credit';
  }
  if (method === 'unpaid') return 'Credit (unpaid)';
  return escapeHtml(String(method || ''));
}

function statusPillHtml(status, profile) {
  const s = String(status || 'paid');
  if (s === 'paid')    return `<span class="rp-status rp-status--paid">Paid</span>`;
  if (s === 'partial') return `<span class="rp-status rp-status--partial">Partial</span>`;
  return `<span class="rp-status rp-status--unpaid">Unpaid</span>`;
}

function storeProfileBlock(store) {
  const lines = [];
  lines.push(`<div class="rp-store">${escapeHtml(store.storeName || '')}</div>`);
  if (store.storeAddress) lines.push(`<div class="rp-store__line">${escapeHtml(store.storeAddress)}</div>`);
  const contact = [store.storePhone, store.storeEmail].filter(Boolean).join(' · ');
  if (contact) lines.push(`<div class="rp-store__line">${escapeHtml(contact)}</div>`);
  if (store.gstin) lines.push(`<div class="rp-store__line">GSTIN: ${escapeHtml(store.gstin)}</div>`);
  return lines.join('');
}

function itemsTableHtml(items, profile) {
  const rows = (items || []).map((it) => {
    const name = escapeHtml(it.product_name || '—');
    const sku  = escapeHtml(it.product_sku || it.product_barcode || '');
    const qty  = Math.max(1, Number(it.quantity || 0));
    const line = Math.max(0, Number(it.line_total_paise || 0));
    const unit = Math.max(0, Number(it.unit_price_paise || 0));
    return `
      <tr class="rp-item">
        <td class="rp-item__name">${name}<span class="rp-item__sku">${sku}</span></td>
        <td class="rp-item__num">${escapeHtml(String(qty))}</td>
        <td class="rp-item__num">${escapeHtml(formatCurrency(unit, profile))}</td>
        <td class="rp-item__num"><strong>${escapeHtml(formatCurrency(line, profile))}</strong></td>
      </tr>`;
  }).join('');
  return `
    <table class="rp-items">
      <thead>
        <tr><th>Item</th><th class="rp-item__num">Qty</th><th class="rp-item__num">Price</th><th class="rp-item__num">Total</th></tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="4" class="rp-empty">No items recorded.</td></tr>`}</tbody>
    </table>`;
}

function totalsHtml(sale, store) {
  const subtotal  = Math.max(0, Number(sale.subtotal_paise || 0));
  const discount  = Math.max(0, Number(sale.discount_paise || 0));
  const tax       = Math.max(0, Number(sale.tax_paise || 0));
  const total     = Math.max(0, Number(sale.total_paise   || 0));
  const taxPct    = Number(sale.tax_percent || 0);
  const taxLabel  = String(store.taxLabel || 'Tax');
  const symbol = store.currencySymbol || '₹';
  const localeFmt = (n) => formatCurrency(n, store);
  const lines = [
    `<div class="rp-total__row"><span>Subtotal</span><span>${escapeHtml(localeFmt(subtotal))}</span></div>`
  ];
  if (discount > 0) lines.push(`<div class="rp-total__row"><span>Discount</span><span>− ${escapeHtml(localeFmt(discount))}</span></div>`);
  if (tax > 0) lines.push(`<div class="rp-total__row"><span>${escapeHtml(taxLabel)}${taxPct ? ` (${taxPct.toFixed(2)}%)` : ''}</span><span>${escapeHtml(localeFmt(tax))}</span></div>`);
  lines.push(`<div class="rp-total__row rp-total__row--final"><span>Total</span><span>${escapeHtml(localeFmt(total))}</span></div>`);
  return lines.join('');
}

function paymentHtml(sale, store) {
  const method    = String(sale.payment_method || '');
  const status    = String(sale.payment_status || (method === 'unpaid' ? 'unpaid' : 'paid'));
  const received  = Math.max(0, Number(sale.amount_received_paise || 0));
  const changeDue = Math.max(0, Number(sale.change_due_paise || 0));
  const localeFmt = (n) => formatCurrency(n, store);
  const lines = [`<div class="rp-pay__row"><span>Method</span><span>${methodLabel(method, status)} <span style="margin-left: 4px;">${statusPillHtml(status, store)}</span></span></div>`];
  if (method === 'cash') {
    lines.push(`<div class="rp-pay__row"><span>Amount received</span><span>${escapeHtml(localeFmt(received))}</span></div>`);
    if (changeDue > 0) {
      lines.push(`<div class="rp-pay__row"><span>Change due</span><span>${escapeHtml(localeFmt(changeDue))}</span></div>`);
    }
  }
  return lines.join('');
}

// ---------------------------------------------------------------------------
// In-app receipt modal — warm look-and-feel, identical data, same renderer.
// ---------------------------------------------------------------------------

export function renderReceiptInnerHtml({ store, sale, items }) {
  if (!sale) return '';
  const localeFmt = (n) => formatCurrency(n, store);
  return `
    <div class="receipt">
      <div class="receipt__head">
        <div class="receipt__store">${storeProfileBlock(store)}</div>
        <div class="receipt__bill-block">
          <div class="receipt__label">Bill number</div>
          <div class="receipt__bill">${escapeHtml(sale.bill_number || '')}</div>
        </div>
      </div>
      <div class="receipt__meta">
        <div><span>Date</span><span>${escapeHtml(sale.created_at_local || sale.created_at || '')}</span></div>
        ${sale.cashier_name  ? `<div><span>Cashier</span><span>${escapeHtml(sale.cashier_name)}</span></div>` : ''}
        ${sale.customer_name ? `<div><span>Customer</span><span>${escapeHtml(sale.customer_name)}</span></div>` : ''}
        ${Number(sale.tax_percent || 0) > 0
          ? `<div><span>${escapeHtml(String(store.taxLabel || 'Tax'))} rate</span><span>${Number(sale.tax_percent).toFixed(2)}%</span></div>`
          : ''}
      </div>
      ${itemsTableHtml(items, store)}
      <div class="receipt__totals">${totalsHtml(sale, store)}</div>
      <div class="receipt__payment">${paymentHtml(sale, store)}</div>
      ${store.receiptFooter
        ? `<div class="receipt__footer">${escapeHtml(store.receiptFooter)}</div>`
        : ''}
      ${sale.notes ? `<div class="receipt__notes"><strong>Notes:</strong> ${escapeHtml(sale.notes)}</div>` : ''}
      <div class="receipt__currency">${escapeHtml(String(store.currencyCode || 'INR'))} · ${escapeHtml(String(store.locale || 'en-IN'))} · formatted with locale-aware grouping.</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Print-friendly document — minimal styling, fits an 80mm thermal roll and
// a Letter / A4 page when printed from the system dialog.
// ---------------------------------------------------------------------------

const PRINT_CSS = `
  @page { margin: 6mm; }
  body { margin: 0; padding: 12px 14px; font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; color: #111; font-size: 12px; line-height: 1.35; }
  .rp-print { width: 280px; margin: 0 auto; }
  .rp-print h1 { font-size: 14px; margin: 0 0 2px 0; text-align: center; letter-spacing: 0.02em; }
  .rp-print .rp-store__line, .rp-print .rp-meta__row { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: #222; }
  .rp-print .rp-store__line { text-align: center; justify-content: center; }
  .rp-print .rp-divider { border-top: 1px dashed #999; margin: 8px 0; }
  .rp-print .rp-bill { text-align: center; font-weight: 700; font-size: 14px; }
  .rp-print .rp-meta { display: grid; gap: 2px; }
  .rp-print .rp-meta__row span:first-child { color: #555; }
  .rp-print table { width: 100%; border-collapse: collapse; }
  .rp-print th { text-align: left; font-weight: 600; border-bottom: 1px dashed #999; padding: 4px 0; font-size: 11px; }
  .rp-print td { padding: 3px 0; vertical-align: top; }
  .rp-print td.rp-item__num, .rp-print th.rp-item__num { text-align: right; font-variant-numeric: tabular-nums; }
  .rp-print .rp-item__name { display: block; }
  .rp-print .rp-item__sku  { display: block; font-size: 10px; color: #555; }
  .rp-print .rp-totals { margin-top: 6px; display: grid; gap: 2px; }
  .rp-print .rp-total__row { display: flex; justify-content: space-between; }
  .rp-print .rp-total__row--final { font-size: 14px; font-weight: 700; margin-top: 4px; border-top: 1px dashed #999; padding-top: 4px; }
  .rp-print .rp-payment { display: grid; gap: 2px; margin-top: 6px; font-size: 11px; }
  .rp-print .rp-pay__row { display: flex; justify-content: space-between; }
  .rp-print .rp-footer { text-align: center; font-size: 11px; color: #444; margin-top: 10px; }
  .rp-print .rp-status { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 4px; font-size: 10px; }
  .rp-print .rp-status--paid    { background: #dcfce7; color: #166534; }
  .rp-print .rp-status--partial { background: #fef3c7; color: #92400e; }
  .rp-print .rp-status--unpaid  { background: #fee2e2; color: #991b1b; }
  .rp-print .rp-currency { text-align: center; margin-top: 8px; font-size: 10px; color: #888; }
`;

export function buildPrintableReceiptHtml({ store, sale, items }) {
  if (!sale) return '';
  const localeFmt = (n) => formatCurrency(n, store);
  // `created_at` is the raw UTC column; `created_at_local` is the shop's
  // wall-clock time and is what a customer expects to see on paper.
  const safeDate = String(sale.created_at_local || sale.created_at || '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Receipt ${escapeHtml(sale.bill_number || '')}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>
  <div class="rp-print">
    <h1>${escapeHtml(store.storeName || '')}</h1>
    ${store.storeAddress ? `<div class="rp-store__line">${escapeHtml(store.storeAddress)}</div>` : ''}
    ${store.storePhone || store.storeEmail
      ? `<div class="rp-store__line">${escapeHtml([store.storePhone, store.storeEmail].filter(Boolean).join(' · '))}</div>`
      : ''}
    ${store.gstin ? `<div class="rp-store__line">GSTIN: ${escapeHtml(store.gstin)}</div>` : ''}
    <div class="rp-divider"></div>
    <div class="rp-bill">${escapeHtml(sale.bill_number || '')}</div>
    <div class="rp-meta">
      <div class="rp-meta__row"><span>Date</span><span>${escapeHtml(safeDate)}</span></div>
      ${sale.cashier_name  ? `<div class="rp-meta__row"><span>Cashier</span><span>${escapeHtml(sale.cashier_name)}</span></div>` : ''}
      ${sale.customer_name ? `<div class="rp-meta__row"><span>Customer</span><span>${escapeHtml(sale.customer_name)}</span></div>` : ''}
      ${Number(sale.tax_percent || 0) > 0
        ? `<div class="rp-meta__row"><span>${escapeHtml(String(store.taxLabel || 'Tax'))} rate</span><span>${Number(sale.tax_percent).toFixed(2)}%</span></div>`
        : ''}
    </div>
    <div class="rp-divider"></div>
    <table>
      <thead><tr>
        <th>Item</th>
        <th class="rp-item__num">Qty</th>
        <th class="rp-item__num">Price</th>
        <th class="rp-item__num">Total</th>
      </tr></thead>
      <tbody>
      ${(items || []).map((it) => `
        <tr>
          <td>
            <span class="rp-item__name">${escapeHtml(it.product_name || '')}</span>
            <span class="rp-item__sku">${escapeHtml(it.product_sku || it.product_barcode || '')}</span>
          </td>
          <td class="rp-item__num">${escapeHtml(String(Math.max(1, Number(it.quantity || 0))))}</td>
          <td class="rp-item__num">${escapeHtml(localeFmt(Math.max(0, Number(it.unit_price_paise || 0))))}</td>
          <td class="rp-item__num"><strong>${escapeHtml(localeFmt(Math.max(0, Number(it.line_total_paise || 0))))}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="rp-divider"></div>
    <div class="rp-totals">
      <div class="rp-total__row"><span>Subtotal</span><span>${escapeHtml(localeFmt(Math.max(0, Number(sale.subtotal_paise || 0))))}</span></div>
      ${Number(sale.discount_paise || 0) > 0
        ? `<div class="rp-total__row"><span>Discount</span><span>− ${escapeHtml(localeFmt(Math.max(0, Number(sale.discount_paise || 0))))}</span></div>`
        : ''}
      ${Number(sale.tax_paise || 0) > 0
        ? `<div class="rp-total__row"><span>${escapeHtml(String(store.taxLabel || 'Tax'))}${Number(sale.tax_percent || 0) ? ` (${Number(sale.tax_percent).toFixed(2)}%)` : ''}</span><span>${escapeHtml(localeFmt(Math.max(0, Number(sale.tax_paise || 0))))}</span></div>`
        : ''}
      <div class="rp-total__row rp-total__row--final"><span>Total</span><span>${escapeHtml(localeFmt(Math.max(0, Number(sale.total_paise || 0))))}</span></div>
    </div>
    <div class="rp-divider"></div>
    <div class="rp-payment">
      <div class="rp-pay__row"><span>Method</span><span>${methodLabel(sale.payment_method, sale.payment_status)} <span style="margin-left: 4px;">${statusPillHtml(sale.payment_status, store)}</span></span></div>
      ${sale.payment_method === 'cash'
        ? `
          <div class="rp-pay__row"><span>Received</span><span>${escapeHtml(localeFmt(Math.max(0, Number(sale.amount_received_paise || 0))))}</span></div>
          ${Number(sale.change_due_paise || 0) > 0
            ? `<div class="rp-pay__row"><span>Change due</span><span>${escapeHtml(localeFmt(Math.max(0, Number(sale.change_due_paise || 0))))}</span></div>`
            : ''}
        `
        : ''}
    </div>
    ${store.receiptFooter
      ? `<div class="rp-divider"></div><div class="rp-footer">${escapeHtml(store.receiptFooter)}</div>`
      : ''}
    <div class="rp-currency">${escapeHtml(String(store.currencyCode || 'INR'))} · printed by QuickBill</div>
  </div>
</body>
</html>`;
}

// Convenience used by views that need both shapes.
export function buildReceiptDocuments(receipt) {
  return {
    html:       receipt ? renderReceiptInnerHtml(receipt) : '',
    printable:  receipt ? buildPrintableReceiptHtml(receipt) : ''
  };
}

export const __internal = { escapeHtml, formatCurrency };
