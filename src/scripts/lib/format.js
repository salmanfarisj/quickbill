// QuickBill — shared presentation helpers.
//
// Small, pure functions that used to be copy-pasted across views. Every
// screen that shows a payment status or an invoice timestamp now calls the
// same code, so the Dashboard, Sales History and Reports can never render the
// same invoice two different ways.
//
// Nothing here touches the DOM or the database; both callers escape the
// results before interpolating them into markup.

const STATUS_LABELS = Object.freeze({
  paid:    'Paid',
  partial: 'Partial',
  unpaid:  'Unpaid'
});

const STATUS_CLASSES = Object.freeze({
  paid:    'pill--paid',
  partial: 'pill--pending',
  unpaid:  'pill--unpaid'
});

/** Canonical payment-status key, or 'unpaid' for anything unrecognised. */
export function statusKey(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? s : 'unpaid';
}

/** Human label for a payment status: 'Paid' / 'Partial' / 'Unpaid'. */
export function statusLabel(status) {
  return STATUS_LABELS[statusKey(status)];
}

/** CSS modifier for a payment status: pill--paid / --pending / --unpaid. */
export function statusClass(status) {
  return STATUS_CLASSES[statusKey(status)];
}

/**
 * Display timestamp for a sale row.
 *
 * The main process already converts the stored UTC `created_at` into the
 * shop's local wall clock and hands it over as `created_at_local`. Views
 * used to disagree about truncating it (one sliced the raw UTC column to 16
 * characters, another printed the formatted value in full), which meant the
 * same invoice showed two different times depending on the screen. Prefer the
 * formatted value; fall back to the raw column only if it is missing.
 */
export function saleTimestamp(sale) {
  if (!sale || typeof sale !== 'object') return '';
  const local = String(sale.created_at_local ?? '').trim();
  if (local) return local;
  return String(sale.created_at ?? '').trim();
}