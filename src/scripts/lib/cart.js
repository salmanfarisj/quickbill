// QuickBill — shopping cart for the Phase 3 checkout preview.
//
// All money math goes through lib/money.js, so every total is an integer
// count of paise — no floating-point drift.
//
// The cart is preview-only in Phase 3: nothing is written to the database,
// no inventory is decremented, no invoice is created. Phase 4 will plug a
// real "checkout" handler onto this same data shape.
//
// Public surface of createCart():
//   state                  snapshot { items, itemCount, subtotalPaise, taxPaise,
//                                   discountPaise, totalPaise, taxPercent,
//                                   discountInput }
//   add(product, qty=1)   — clamped to the product's stock_quantity
//   setQuantity(barcode, qty) — qty 0 removes the line (see below)
//   remove(barcode)
//   clear()                — empties lines + discount, keeps the tax rate
//   setDiscount(input)     — accepts rupee string or paise; validates
//   setTaxPercent(percent) — accepts percent as JS number; validates 0…1000
//   subscribe(fn)          — fn(state) called after every mutation
//   findByBarcode(barcode) — returns cart line or null

import {
  fromRupees, add as addPaise, sub as subPaise, mul, mulPercent,
  applyDiscount, parseAmount, isValidAmount, MoneyError
} from './money.js';

const MIN_QTY = 1;
const MAX_QTY = 9999;
// Upper bound accepted by the main process (`createSale` rejects anything
// above it), mirrored here so the cart can never hold an un-saleable rate.
const MAX_TAX_PERCENT = 1000;

/**
 * Create a fresh cart instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.defaultTaxPercent=0]   initial tax percentage
 */
export function createCart(opts = {}) {
  const listeners = new Set();
  /** @type {Map<string, {product:object, quantity:number, lineTotalPaise:number, unitPricePaise:number}>} */
  const items = new Map();
  let discountInput = '0';
  let taxPercent = Number.isFinite(opts.defaultTaxPercent) ? opts.defaultTaxPercent : 0;

  function emit() {
    const snapshot = getState();
    for (const fn of listeners) {
      try { fn(snapshot); } catch (e) { console.error('[cart] subscriber failed:', e); }
    }
  }

  function recompute(line) {
    line.lineTotalPaise = mul(line.unitPricePaise, line.quantity);
  }

  function clampQuantity(qty) {
    if (!Number.isInteger(qty)) throw new CartError('Quantity must be a whole number.', 'QTY_NOT_INTEGER');
    if (qty < MIN_QTY) throw new CartError(`Quantity must be at least ${MIN_QTY}.`, 'QTY_TOO_LOW');
    if (qty > MAX_QTY) throw new CartError(`Quantity cannot exceed ${MAX_QTY}.`, 'QTY_TOO_HIGH');
    return qty;
  }

  function findProductBarcode(product) {
    return String(product.barcode ?? '').trim();
  }

  // Stock ceiling for a product, or null when the row carries no usable
  // `stock_quantity` (services, untracked stock) and only MAX_QTY applies.
  function stockCeiling(product) {
    const raw = Number(product.stock_quantity);
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.min(MAX_QTY, Math.trunc(raw));
  }

  function add(product, qty = 1) {
    if (!product || typeof product !== 'object') {
      throw new CartError('Product is required.', 'PRODUCT_MISSING');
    }
    const barcode = findProductBarcode(product);
    if (!barcode) throw new CartError('Product has no barcode.', 'PRODUCT_NO_BARCODE');
    const safeQty = clampQuantity(qty);
    const unitPricePaise = fromRupees(product.selling_price);
    const line = items.get(barcode);
    const current = line ? line.quantity : 0;
    const wanted = clampQuantity(current + safeQty);

    // The shelf is the ceiling: never show a quantity the main process would
    // reject at checkout. `stockCeiling()` is null for untracked products.
    const ceiling = stockCeiling(product);
    let finalQty = wanted;
    let capped = false;
    if (ceiling !== null && wanted > ceiling) {
      if (ceiling <= current) {
        // Already at (or past) what is on the shelf — nothing to add.
        throw new CartError(
          `${product.name || barcode} is out of stock.`,
          'OUT_OF_STOCK'
        );
      }
      finalQty = ceiling;
      capped = true;
    }

    if (line) {
      line.quantity = finalQty;
      recompute(line);
    } else {
      items.set(barcode, {
        product: { ...product },
        quantity: finalQty,
        unitPricePaise,
        lineTotalPaise: mul(unitPricePaise, finalQty)
      });
    }
    emit();

    // Added at the capped quantity, but the cashier still deserves to know
    // the number they asked for was not available.
    if (capped) {
      throw new CartError(
        `Only ${ceiling - current} more of ${product.name || barcode} in stock — quantity set to ${ceiling}.`,
        'INSUFFICIENT_STOCK'
      );
    }
  }

  // Quantity 0 removes the line (see the module header): that is what the
  // "−" button means at quantity 1, so the caller never has to special-case
  // an error toast for the obviously-intended action.
  function setQuantity(barcode, qty) {
    const key = String(barcode);
    const line = items.get(key);
    if (!line) throw new CartError('Item not in cart.', 'NOT_IN_CART');
    const parsed = typeof qty === 'number' ? qty : Number(qty);
    if (!Number.isFinite(parsed)) {
      throw new CartError('Quantity must be a number.', 'QTY_INVALID');
    }
    if (!Number.isInteger(parsed)) {
      throw new CartError('Quantity must be a whole number.', 'QTY_NOT_INTEGER');
    }
    if (parsed === 0) {
      items.delete(key);
      emit();
      return;
    }
    line.quantity = clampQuantity(parsed);
    recompute(line);
    emit();
  }

  function remove(barcode) {
    const key = String(barcode);
    if (!items.delete(key)) return false;
    emit();
    return true;
  }

  // Empties the invoice but keeps the configured tax rate: the rate belongs to
  // the store, not to the sale, so resetting it here would silently bill every
  // sale after the first at 0%.
  function clear() {
    items.clear();
    discountInput = '0';
    emit();
  }

  function setDiscount(input) {
    const raw = input === null || input === undefined ? '' : String(input).trim();
    if (raw === '') {
      discountInput = '0';
    } else if (isValidAmount(raw)) {
      discountInput = raw;
    } else {
      throw new CartError('Enter a valid discount amount.', 'DISCOUNT_INVALID');
    }
    emit();
  }

  function setTaxPercent(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) throw new CartError('Tax must be a number.', 'TAX_INVALID');
    if (n < 0) throw new CartError('Tax cannot be negative.', 'TAX_INVALID');
    // Same ceiling the main process enforces in createSale, so the cart can
    // never hold a rate that would be rejected at checkout.
    if (n > MAX_TAX_PERCENT) throw new CartError(`Tax cannot exceed ${MAX_TAX_PERCENT}%.`, 'TAX_TOO_HIGH');
    taxPercent = n;
    emit();
  }

  function getState() {
    const lines = Array.from(items.values()).map((b) => ({
      barcode:    b.product.barcode,
      sku:        b.product.sku,
      name:       b.product.name,
      category:   b.product.category,
      unitPricePaise: b.unitPricePaise,
      quantity:   b.quantity,
      lineTotalPaise: b.lineTotalPaise,
      product:    b.product
    }));
    const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
    const subtotalPaise = lines.reduce((s, l) => addPaise(s, l.lineTotalPaise), 0);
    const discountPaise = parseAmountOrZero(discountInput);
    // One clamp, defined in money.js — the same call db.js makes at checkout.
    const afterDiscount = applyDiscount(subtotalPaise, discountPaise);
    const taxPaise = mulPercent(afterDiscount, taxPercent);
    const totalPaise = afterDiscount + taxPaise;
    return {
      lines,
      itemCount,
      subtotalPaise,
      discountInput,
      discountPaise: Math.min(discountPaise, subtotalPaise),
      taxPercent,
      taxPaise,
      totalPaise,
      isEmpty: lines.length === 0
    };
  }

  function subscribe(fn) {
    listeners.add(fn);
    // Push the current snapshot synchronously so subscribers can paint on attach.
    try { fn(getState()); } catch (e) { console.error('[cart] subscriber failed:', e); }
    return () => listeners.delete(fn);
  }

  function findByBarcode(barcode) {
    const line = items.get(String(barcode));
    return line ? { ...line } : null;
  }

  return {
    add, setQuantity, remove, clear,
    setDiscount, setTaxPercent,
    subscribe, getState, findByBarcode
  };
}

function parseAmountOrZero(input) {
  if (!isValidAmount(input)) return 0;
  try { return parseAmount(input); }
  catch { return 0; }
}

export class CartError extends Error {
  constructor(message, code = 'CART_INVALID') {
    super(message);
    this.name = 'CartError';
    this.code = code;
  }
}

export { applyDiscount };