// QuickBill — currency helpers used by the main process.
//
// Mirrors src/scripts/lib/money.js (renderer), but in CommonJS so the
// authoritative checkout path can compute prices, discount, tax, change
// and totals the same way without floating-point drift.
//
// All monetary values inside the main process are stored as **integer
// count of paise** (1 INR = 100 paise). The DB schema uses INTEGER columns
// named `*_paise` for exactly this reason.

'use strict';

class MoneyError extends Error {
  constructor(message, code = 'MONEY_INVALID') {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

const RUPEES_RE = /^-?(?:\d+|\d*\.\d{1,2})$/;

function toFiniteInt(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError('Money value must be a finite number.', code);
  }
  return Math.trunc(value);
}

/**
 * Parse a rupee string ("12", "12.50") into integer paise.
 * Rejects negatives. Throws on bad input.
 */
function parseAmount(input) {
  if (input === null || input === undefined || input === '') {
    throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  }
  const raw = String(input).trim();
  if (raw === '') throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  if (!RUPEES_RE.test(raw)) {
    throw new MoneyError('Enter a valid amount with up to 2 decimal places.', 'MONEY_FORMAT');
  }
  if (raw.startsWith('-')) {
    throw new MoneyError('Amount cannot be negative.', 'MONEY_NEGATIVE');
  }
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  const whole = wholeRaw === '' ? 0 : Number(wholeRaw);
  const frac = Number((fracRaw + '00').slice(0, 2));
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) {
    throw new MoneyError('Enter a valid amount.', 'MONEY_FORMAT');
  }
  return Math.trunc(whole * 100 + frac);
}

/**
 * Convert rupees (number or numeric string) to integer paise.
 * Accepts negatives (caller decides semantics).
 */
function fromRupees(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') {
    throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  }
  const n = typeof rupees === 'number' ? rupees : Number(rupees);
  if (!Number.isFinite(n)) {
    throw new MoneyError('Amount must be a number.', 'MONEY_FORMAT');
  }
  return Math.round(n * 100);
}

function add(a, b) {
  return toFiniteInt(a, 'MONEY_INVALID') + toFiniteInt(b, 'MONEY_INVALID');
}

function sub(a, b) {
  return toFiniteInt(a, 'MONEY_INVALID') - toFiniteInt(b, 'MONEY_INVALID');
}

function mul(paise, qty) {
  return toFiniteInt(paise, 'MONEY_INVALID') * toFiniteInt(qty, 'MONEY_INVALID');
}

/**
 * Apply a percent surcharge. `percent` is e.g. 5 for 5%. Half-to-even
 * rounding at the paise boundary.
 */
function mulPercent(paise, percent) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  const r = Number(percent);
  if (!Number.isFinite(r)) {
    throw new MoneyError('Percent must be a finite number.', 'MONEY_FORMAT');
  }
  const hundredths = Math.round(r * 100);
  const raw = p * hundredths;
  const quotient = Math.trunc(raw / 10000);
  const remainder = raw - quotient * 10000;
  if (remainder === 5000) {
    return quotient + (quotient % 2 === 0 ? 0 : 1);
  }
  return quotient + (remainder > 5000 ? 1 : 0);
}

function applyDiscount(subtotalPaise, discountPaise) {
  const s = toFiniteInt(subtotalPaise, 'MONEY_INVALID');
  const d = toFiniteInt(discountPaise, 'MONEY_INVALID');
  if (d < 0) throw new MoneyError('Discount cannot be negative.', 'MONEY_NEGATIVE');
  return s - (d > s ? s : d);
}

module.exports = {
  MoneyError,
  parseAmount,
  fromRupees,
  add,
  sub,
  mul,
  mulPercent,
  applyDiscount
};
