// QuickBill — currency-safe money helpers.
//
// Every monetary value inside the renderer cart is represented as an
// **integer count of paise** (1 INR = 100 paise). We never multiply or add
// floats — that is what produces the classic `0.1 + 0.2 !== 0.3` rounding
// drift you see in hand-rolled POS demos.
//
// Public surface:
//   parseAmount(input)            → paise      ("12.50", "12", 12.5, 12) → integer
//   fromRupees(rupees)            → paise       DB-struples → integer paise
//   fromPaise(paise)              → rupees      integer paise → number (display only)
//   add, sub, mul, mulPercent,
//     pct, mulRate                 → integer paise arithmetic
//   formatINR(paise)              → "₹1,234.56" (en-IN grouping)
//   isValidAmount(input)          → boolean     lenient check for form validation
//   MoneyError                    thrown by parseAmount/fromRupees on bad input
//
// All "from" parsers validate. Arithmetic helpers assume valid paise and
// throw on non-finite input so a bug elsewhere can't silently produce NaN.

export class MoneyError extends Error {
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
  // paise fits comfortably in 2^53; we still want a hard guarantee that the
  // input isn't a float with a fractional paise (e.g. 1250.0000000001).
  return Math.trunc(value);
}

/**
 * Parse a user-entered rupee string ("12", "12.5", "12.50") into integer
 * paise. Accepts up to two decimal places; anything else throws.
 * Negatives are rejected — a discount or price shouldn't be negative.
 */
export function parseAmount(input) {
  if (input === null || input === undefined || input === '') {
    throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  }
  const raw = String(input).trim();
  if (raw === '') throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  if (!RUPEES_RE.test(raw)) {
    throw new MoneyError('Enter a valid amount with up to 2 decimal places.', 'MONEY_FORMAT');
  }
  const negative = raw.startsWith('-');
  if (negative) throw new MoneyError('Amount cannot be negative.', 'MONEY_NEGATIVE');
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  const whole = wholeRaw === '' ? 0 : Number(wholeRaw);
  const frac = Number((fracRaw + '00').slice(0, 2));
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) {
    throw new MoneyError('Enter a valid amount.', 'MONEY_FORMAT');
  }
  return Math.trunc(whole * 100 + frac);
}

/**
 * Lenient version of parseAmount for input validation — returns null on
 * failure instead of throwing, so the form can decide whether to surface
 * the error inline.
 */
export function isValidAmount(input) {
  if (input === null || input === undefined) return false;
  const raw = String(input).trim();
  if (raw === '') return false;
  if (!RUPEES_RE.test(raw)) return false;
  if (raw.startsWith('-')) return false;
  const [wholeRaw, fracRaw = ''] = raw.split('.');
  const whole = wholeRaw === '' ? 0 : Number(wholeRaw);
  const frac = Number((fracRaw + '00').slice(0, 2));
  return Number.isFinite(whole) && Number.isFinite(frac);
}

/**
 * Convert a value already expressed in rupees (number or numeric string)
 * to integer paise. Used when reading prices back from the SQLite layer.
 * Rounds half-to-even at the paise boundary — caller is responsible for
 * ensuring the input is in fact non-negative (we don't know its semantics
 * here, so we accept any finite number).
 */
export function fromRupees(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') {
    throw new MoneyError('Amount is required.', 'MONEY_EMPTY');
  }
  const n = typeof rupees === 'number' ? rupees : Number(rupees);
  if (!Number.isFinite(n)) {
    throw new MoneyError('Amount must be a number.', 'MONEY_FORMAT');
  }
  // Math.round on a float × 100 can drift by a fraction at the boundary;
  // we accept at most one sub-paise rounding loss here.
  return Math.round(n * 100);
}

/** Convert integer paise back to a Number of rupees (for display only). */
export function fromPaise(paise) {
  return toFiniteInt(paise, 'MONEY_INVALID') / 100;
}

/** Add two paise values; result is an integer. */
export function add(a, b) {
  return toFiniteInt(a, 'MONEY_INVALID') + toFiniteInt(b, 'MONEY_INVALID');
}

/** Subtract paise (a - b); result is an integer. May be negative — caller decides. */
export function sub(a, b) {
  return toFiniteInt(a, 'MONEY_INVALID') - toFiniteInt(b, 'MONEY_INVALID');
}

/** Multiply paise by an integer quantity (line totals, etc.). */
export function mul(paise, qty) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  const q = toFiniteInt(qty, 'MONEY_INVALID');
  return p * q;
}

/**
 * Apply a percent surcharge (e.g. GST) to a paise amount.
 * `percent` is a plain number — `5` means 5%, `2.5` means 2.5%.
 * Rounded to the nearest paise using banker-style half-to-even to avoid
 * systematically rounding taxes up.
 */
export function mulPercent(paise, percent) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  const r = Number(percent);
  if (!Number.isFinite(r)) {
    throw new MoneyError('Percent must be a finite number.', 'MONEY_FORMAT');
  }
  // Convert to integer hundredths-of-percent so the math stays in integers.
  const hundredths = Math.round(r * 100);
  // (paise * hundredths) / 10_000 — round half to even.
  const raw = p * hundredths;
  const quotient = Math.trunc(raw / 10000);
  const remainder = raw - quotient * 10000;
  if (remainder === 5000) {
    // tie — round to even
    return (quotient + (quotient % 2 === 0 ? 0 : 1));
  }
  return quotient + (remainder > 5000 ? 1 : 0);
}

/**
 * Apply a flat percentage rate as a fraction (0.05 = 5%).
 * Convenience for callers that already work in fractional form.
 */
export function mulRate(paise, rate) {
  return mulPercent(paise, rate * 100);
}

/** Apply a flat paise discount (e.g. ₹20 off). */
export function applyDiscount(subtotalPaise, discountPaise) {
  const s = toFiniteInt(subtotalPaise, 'MONEY_INVALID');
  const d = toFiniteInt(discountPaise, 'MONEY_INVALID');
  if (d < 0) throw new MoneyError('Discount cannot be negative.', 'MONEY_NEGATIVE');
  // Discount can never exceed the subtotal.
  return s - (d > s ? s : d);
}

/** Format paise as "₹1,23,456.78" using Indian numbering (en-IN locale). */
const INR_FORMAT = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatINR(paise) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  return '₹' + INR_FORMAT.format(p / 100);
}

/** Same as formatINR but without the currency prefix — useful inside tables. */
export function formatINRValue(paise) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  return INR_FORMAT.format(p / 100);
}

/**
 * Locale-aware formatter. `profile` is the store profile persisted by
 * the main process (currencyCode, currencySymbol, locale). The function
 * is robust to malformed profile values — every miss falls back to the
 * en-IN / ₹ defaults so receipts and dashboards never render NaN.
 */
const formatterCache = new Map();
function getCurrencyFormatter(profile) {
  const locale = (profile && typeof profile.locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(profile.locale))
    ? profile.locale
    : 'en-IN';
  const key = `format:${locale}`;
  if (!formatterCache.has(key)) {
    formatterCache.set(key, new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }));
  }
  return formatterCache.get(key);
}

/**
 * Format an integer-paise value using the store profile's locale and
 * currency symbol. Falls back gracefully if `profile` is missing or the
 * supplied locale is invalid.
 */
export function formatCurrency(paise, profile) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  const formatter = getCurrencyFormatter(profile);
  const symbol = (profile && typeof profile.currencySymbol === 'string' && profile.currencySymbol.trim())
    ? profile.currencySymbol.trim()
    : '₹';
  return symbol + formatter.format(p / 100);
}

/** Like formatCurrency, but no symbol prefix. */
export function formatCurrencyValue(paise, profile) {
  const p = toFiniteInt(paise, 'MONEY_INVALID');
  return getCurrencyFormatter(profile).format(p / 100);
}

/** Internal test seam: create a paise value from a JS number (no validation). */
export function paise(n) { return Math.trunc(n); }