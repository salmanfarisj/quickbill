// QuickBill — renderer-side print helper.
//
// Both Billing and Sales History need to print the same receipt. This
// module talks to the main process: it asks for the system printers,
// resolves the receipt profile from the persistent sales ledger, builds
// the printable HTML via lib/receipt.js, and dispatches it to
// Electron's webContents.print() pipeline.
//
// All errors (NO_PRINTER, PRINTER_CANCELLED, PRINTER_FAILED) are mapped
// to user-friendly messages so callers can simply forward the message
// to a toast / banner.

import { buildPrintableReceiptHtml } from './receipt.js';

const receiptApi = window.quickbill?.receipt;

// Every result carries `data` (null on failure) so callers can destructure
// without a shape check, plus the real `code`/`message` for the toast.
function fail(res, fallbackMessage) {
  if (!res) return { ok: false, message: fallbackMessage, code: 'UNKNOWN', data: null };
  if (res.ok) return res;
  const code = res.error?.code || 'UNKNOWN';
  return { ok: false, code, message: res.error?.message || fallbackMessage, data: null };
}

export async function loadReceiptForSale(saleId) {
  if (!receiptApi?.forSale) {
    return { ok: false, code: 'IPC_MISSING', message: 'Receipt API is unavailable.', data: null };
  }
  const res = await receiptApi.forSale(saleId);
  return fail(res, 'Could not load receipt.');
}

export async function listPrinters() {
  if (!receiptApi?.printers) {
    return { ok: false, code: 'IPC_MISSING', message: 'Printer API is unavailable.', data: { printers: [] } };
  }
  const res = await receiptApi.printers();
  if (!res.ok) return { ok: false, code: res.error?.code || 'UNKNOWN', message: res.error?.message || 'Could not list printers.', data: { printers: [] } };
  return { ok: true, data: res.data || { printers: [] } };
}

export async function printSaleReceipt(saleId, { printer = '', copies = 1, receipt = null } = {}) {
  let payload = receipt;
  if (!payload || !payload.sale) {
    const loaded = await loadReceiptForSale(saleId);
    // Forward the real reason (NO_SALE, DB error, …) instead of hiding it
    // behind a generic message — the caller shows this to the cashier.
    if (!loaded.ok) {
      return { ok: false, code: loaded.code || 'NOT_FOUND', message: loaded.message || 'Receipt could not be loaded.', data: null };
    }
    payload = loaded.data;
  }
  if (!payload || !payload.sale) {
    return { ok: false, code: 'NOT_FOUND', message: 'Receipt could not be loaded.', data: null };
  }
  const html = buildPrintableReceiptHtml(payload);
  if (!receiptApi?.print) {
    return { ok: false, code: 'IPC_MISSING', message: 'Print API is unavailable.', data: null };
  }
  const res = await receiptApi.print({ html, printer, copies });
  return fail(res, 'Could not print the receipt.');
}
