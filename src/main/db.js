// QuickBill — database layer.
// Lives in the main process so it never touches the renderer; the renderer
// talks to it through the IPC handlers wired in main.js.
//
// Storage: a single SQLite file inside app.getPath('userData'), so the data
// survives app restarts and upgrades but is never written into the packaged
// application directory (which is read-only on most installs).
//
// Driver: better-sqlite3 (synchronous, single-process, no extra worker thread).
// It is rebuilt against Electron's Node ABI via @electron/rebuild; this repo
// already runs `npx electron-rebuild -f -w better-sqlite3` as part of install.
//
// All queries use parameterised statements — never string concatenation.

const path = require('node:path');
const fs   = require('node:fs');
const Database = require('better-sqlite3');
const money = require('./money.js');

// ---------------------------------------------------------------------------
// Sale defaults — Phase 4
// ---------------------------------------------------------------------------

// Daily bill serial resets every calendar day. Counters are stored in the
// `idempotency` table (see SCHEMA below). When two invoices would land on
// the same number we retry the bill-number lookup, so the UNIQUE constraint
// is the safety net, not the primary generator.
const BILL_NUMBER_PREFIX = 'INV';
const BILL_NUMBER_PAD    = 4;
const MAX_BILL_NUMBER_RETRIES = 5;

// Default GST rate used by the renderer when none has been configured.
// Tax is intentionally **configurable** — QuickBill does not invent the
// applicable GST rate; verify your jurisdiction's rules before commercial
// use. See README "Phase 4 — Tax configuration" for details.
const DEFAULT_TAX_PERCENT = 0;

// Field metadata used by `setStoreProfile` to validate user input. The
// renderer also reads this so it can render sensible form hints.
const STORE_PROFILE_FIELDS = Object.freeze({
  storeName:      { trim: true,  max: 120,  required: true  },
  storeAddress:   { trim: true,  max: 240,  required: false },
  storePhone:     { trim: true,  max: 40,   required: false },
  storeEmail:     { trim: true,  max: 120,  required: false },
  gstin:          { trim: true,  max: 32,   required: false },
  currencyCode:   { trim: true,  max: 8,    required: true,  pattern: /^[A-Z]{3}$/ },
  currencySymbol: { trim: true,  max: 4,    required: true  },
  locale:         { trim: true,  max: 24,   required: true,  pattern: /^[a-z]{2}(-[A-Z]{2})?$/ },
  taxLabel:       { trim: true,  max: 32,   required: true  },
  invoicePrefix:  { trim: true,  max: 12,   required: true,  pattern: /^[A-Z0-9_-]+$/ },
  receiptFooter:  { trim: true,  max: 240,  required: false }
});

// Default store profile used when nothing has been configured. Keep this
// small + safe — receipts always render with a non-empty store name and a
// footer that is human-editable in Settings.
const DEFAULT_STORE_PROFILE = Object.freeze({
  storeName:      'QuickBill Store',
  storeAddress:   '',
  storePhone:     '',
  storeEmail:     '',
  gstin:          '',
  currencyCode:   'INR',
  currencySymbol: '₹',
  locale:         'en-IN',
  taxLabel:       'Tax',
  invoicePrefix:  BILL_NUMBER_PREFIX,
  receiptFooter:  'Thank you for shopping with us!',
  taxPercent:     DEFAULT_TAX_PERCENT
});

// ---------------------------------------------------------------------------
// Time handling — local-day bucketing.
//
// `sales.created_at` is written by SQLite's `datetime('now')`, which is UTC.
// Every calendar-day filter in this module must therefore convert to the
// machine's local day before comparing against a `YYYY-MM-DD` bound, or a
// sale rung up between 00:00 and the UTC offset (00:00-05:30 in IST) lands in
// the previous day's bucket and vanishes from "today".
//
// This is deliberately a READ-SIDE conversion. We never rewrite stored
// timestamps: the ledger is append-only, and a migration that re-stamps
// `created_at` in place would (a) mutate completed records, which requirement
// 8 forbids, and (b) bake in the UTC offset of whichever machine happened to
// open the database first — wrong for any DB synced from another timezone.
//
// `datetime(created_at, 'localtime')` applies the machine's offset at read
// time and yields 'YYYY-MM-DD HH:MM:SS', so `substr(..., 1, 10)` is the local
// calendar day.
// ---------------------------------------------------------------------------

// Reusable SQL fragment: the local calendar day of a sales row.
const LOCAL_DAY_SQL = `substr(datetime(created_at, 'localtime'), 1, 10)`;

// Same fragment, qualified for the `sales` alias used by JOINed queries.
const LOCAL_DAY_SQL_ALIASED = `substr(datetime(s.created_at, 'localtime'), 1, 10)`;

// Local `YYYY-MM-DD` for a given Date. Every day bucket in the app (bill
// numbers, date filters, reports) is a LOCAL calendar day, so this is the one
// place that turns a Date into that key.
function localDayKey(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localTodayIso() {
  return localDayKey(new Date());
}

// Inverse of localDayKey: 'YYYY-MM-DD' -> the local Date at midnight on that
// day, or null when the string is not a real calendar date.
//
// Built from local components rather than `new Date(key)`, which parses as
// UTC midnight and would shift the day backwards for any timezone west of
// Greenwich. Callers that walk a day-by-day window need `setDate()` to
// advance in local time so a DST boundary cannot skip or repeat a key.
function dayKeyToLocalDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  // Rejects overflowing dates such as 2026-02-31, which Date would roll
  // forward into March and silently shift the window.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

// UTC stamp in the exact shape SQLite's `datetime('now')` produces, which is
// what `created_at` columns store. `formatLocalTimestamp` parses it back.
function toSqliteUtcStamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// An OWN, valid Date — not one inherited from a prototype chain. Reading
// `internal.createdAt` directly would accept a Date hung off
// `Object.prototype`, which would quietly let a caller backdate a sale it has
// no business backdating. createSale's timestamp override is a trust
// boundary, so make it one explicitly rather than relying on every caller's
// hygiene.
function ownCreatedAt(internal) {
  if (!internal || typeof internal !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(internal, 'createdAt')) return null;
  const value = internal.createdAt;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value;
}

const SALE_PAYMENT_METHODS = new Set(['cash', 'unpaid']);
const SALE_PAYMENT_STATUSES = new Set(['paid', 'unpaid', 'partial']);

// Payment status is derived, never stored as a freeform string.
function derivePaymentStatus(totalPaise, amountReceivedPaise) {
  if (amountReceivedPaise >= totalPaise) return { status: 'paid',    changeDuePaise: amountReceivedPaise - totalPaise };
  if (amountReceivedPaise > 0)           return { status: 'partial', changeDuePaise: 0 };
  return                                    { status: 'unpaid',  changeDuePaise: 0 };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode          TEXT    NOT NULL UNIQUE,
  sku              TEXT    NOT NULL UNIQUE,
  name             TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'General',
  cost_price       REAL    NOT NULL DEFAULT 0 CHECK (cost_price      >= 0),
  selling_price    REAL    NOT NULL DEFAULT 0 CHECK (selling_price   >= 0),
  stock_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity  >= 0),
  min_stock_level  INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_level >= 0),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name);

-- ===========================================================================
-- Phase 4 — Sales ledger
-- ===========================================================================
-- Sales and their line items live in two tables, normalised so a single
-- invoice can be reopened, reprinted and amended. Money is stored in
-- INTEGER paise — see src/main/money.js — so totals never drift.
--
-- bill_number is globally UNIQUE; the generator uses a YYYY-MM-DD prefix
-- with a daily serial and falls back to the UNIQUE constraint as the
-- ultimate safeguard.
CREATE TABLE IF NOT EXISTS sales (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_number            TEXT    NOT NULL UNIQUE,
  subtotal_paise         INTEGER NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise         INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_paise              INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise            INTEGER NOT NULL CHECK (total_paise >= 0),
  tax_percent            REAL    NOT NULL DEFAULT 0,
  payment_method         TEXT    NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','unpaid')),
  payment_status         TEXT    NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid','unpaid','partial')),
  amount_received_paise  INTEGER NOT NULL DEFAULT 0 CHECK (amount_received_paise >= 0),
  change_due_paise       INTEGER NOT NULL DEFAULT 0 CHECK (change_due_paise >= 0),
cashier_name         TEXT    NOT NULL DEFAULT '',
  customer_name        TEXT    NOT NULL DEFAULT '',
  notes                TEXT    NOT NULL DEFAULT '',
  -- Currency/tax presentation is FROZEN at checkout (requirement 8). A sale
  -- rung up in INR must keep printing as INR even after the operator edits
  -- the store profile, otherwise reopening a completed invoice silently
  -- re-labels it ("₹2.40" reprinted as "$2.40"). The *_code columns record
  -- the units; *_symbol/locale are how that money was presented. Rows written
  -- before this migration keep NULL here and fall back to the live profile.
  currency_code        TEXT,
  currency_symbol      TEXT,
  locale               TEXT,
  tax_label            TEXT,
  store_name           TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_bill       ON sales(bill_number);

CREATE TABLE IF NOT EXISTS sale_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id          INTEGER NOT NULL REFERENCES sales(id)    ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_barcode  TEXT    NOT NULL,
  product_sku      TEXT    NOT NULL,
  product_name     TEXT    NOT NULL,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_paise INTEGER NOT NULL CHECK (line_total_paise >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);

-- ===========================================================================
-- Settings (tax rate etc.)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ===========================================================================
-- Idempotency table — protects against accidental double-billing if the
-- renderer retries the same client_request_id (e.g. after a network
-- hiccup). If the same id has already produced a sale, we return the
-- original sale without inserting anything new.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS idempotency (
  client_request_id TEXT PRIMARY KEY,
  sale_id           INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

// Categories seeded once — keeps the renderer filter dropdown stable.
const SAMPLE_CATEGORIES = [
  'Beverages', 'Dairy', 'Bakery', 'Snacks', 'Produce',
  'Grocery', 'Frozen', 'Personal Care', 'Household', 'General'
];

// Sample products used by `seedSampleProducts`. Uses stable barcodes so the
// seeder is idempotent: re-running it inserts new rows only for barcodes that
// aren't already present.
const SAMPLE_PRODUCTS = [
  { barcode: '8901030865278', sku: 'BEV-031', name: 'Sparkling Water 1L',        category: 'Beverages',     cost_price: 0.60, selling_price: 1.20, stock_quantity: 48, min_stock_level: 15 },
  { barcode: '8901030865285', sku: 'BEV-032', name: 'Orange Juice 1L',           category: 'Beverages',     cost_price: 1.80, selling_price: 3.49, stock_quantity: 22, min_stock_level: 10 },
  { barcode: '8901030120001', sku: 'DAI-004', name: 'Whole Milk 1L',             category: 'Dairy',         cost_price: 1.10, selling_price: 2.10, stock_quantity:  3, min_stock_level: 10 },
  { barcode: '8901030120018', sku: 'DAI-005', name: 'Greek Yogurt 500g',         category: 'Dairy',         cost_price: 1.95, selling_price: 3.79, stock_quantity: 14, min_stock_level:  8 },
  { barcode: '8901030120025', sku: 'BAK-012', name: 'Sourdough Loaf',            category: 'Bakery',        cost_price: 1.40, selling_price: 3.20, stock_quantity:  5, min_stock_level: 12 },
  { barcode: '8901030120032', sku: 'BAK-013', name: 'Whole Wheat Bread',         category: 'Bakery',        cost_price: 1.20, selling_price: 2.85, stock_quantity: 18, min_stock_level: 10 },
  { barcode: '8901030120049', sku: 'SNK-077', name: 'Dark Chocolate Bar 100g',   category: 'Snacks',        cost_price: 1.10, selling_price: 2.49, stock_quantity:  6, min_stock_level: 20 },
  { barcode: '8901030120056', sku: 'SNK-078', name: 'Salted Potato Chips 150g',  category: 'Snacks',        cost_price: 0.95, selling_price: 2.19, stock_quantity: 35, min_stock_level: 15 },
  { barcode: '8901030120063', sku: 'PRO-101', name: 'Bananas (1 kg)',             category: 'Produce',       cost_price: 0.70, selling_price: 1.49, stock_quantity: 60, min_stock_level: 20 },
  { barcode: '8901030120070', sku: 'PRO-102', name: 'Red Apples (1 kg)',          category: 'Produce',       cost_price: 1.30, selling_price: 2.69, stock_quantity: 42, min_stock_level: 15 },
  { barcode: '8901030120087', sku: 'GRO-201', name: 'Olive Oil 500ml',           category: 'Grocery',       cost_price: 4.50, selling_price: 8.99, stock_quantity: 24, min_stock_level: 10 },
  { barcode: '8901030120094', sku: 'GRO-202', name: 'Brown Rice 1 kg',           category: 'Grocery',       cost_price: 1.40, selling_price: 3.29, stock_quantity: 30, min_stock_level: 12 },
  { barcode: '8901030120100', sku: 'FRZ-301', name: 'Frozen Peas 500g',          category: 'Frozen',        cost_price: 1.20, selling_price: 2.79, stock_quantity: 16, min_stock_level:  8 },
  { barcode: '8901030120117', sku: 'PER-401', name: 'Toilet Paper 9-pack',       category: 'Personal Care', cost_price: 4.20, selling_price: 8.49, stock_quantity: 12, min_stock_level: 10 },
  { barcode: '8901030120124', sku: 'HHS-403', name: 'Laundry Detergent 1L',      category: 'Household',     cost_price: 3.30, selling_price: 6.99, stock_quantity:  9, min_stock_level:  6 }
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Returns a plain { ok, errors } object. Errors are field-keyed so the
// renderer can place them next to the right input.
function validateProductInput(input, { isUpdate = false } = {}) {
  const errors = {};
  const required = ['barcode', 'sku', 'name'];
  for (const key of required) {
    if (!input[key] || !String(input[key]).trim()) {
      errors[key] = 'Required';
    }
  }
  // Numeric fields: cost_price, selling_price, stock_quantity, min_stock_level
  const numeric = ['cost_price', 'selling_price', 'stock_quantity', 'min_stock_level'];
  for (const key of numeric) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      errors[key] = 'Required';
      continue;
    }
    const n = Number(input[key]);
    if (!Number.isFinite(n)) {
      errors[key] = 'Must be a number';
      continue;
    }
    if (n < 0) {
      errors[key] = 'Cannot be negative';
      continue;
    }
    if ((key === 'stock_quantity' || key === 'min_stock_level') && !Number.isInteger(n)) {
      errors[key] = 'Must be a whole number';
    }
  }
  if (!errors.selling_price && Number(input.selling_price) < Number(input.cost_price ?? 0)) {
    errors.selling_price = 'Selling price must be ≥ cost price';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  if (isUpdate && !input.id) {
    return { ok: false, errors: { id: 'Missing product id' } };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Database factory
// ---------------------------------------------------------------------------

// Format a stored UTC `created_at` for humans — receipts and history rows
// must show the shop's local wall-clock time, not UTC. `Intl.DateTimeFormat`
// does the offset conversion using the machine's zone.
//
// SQLite emits 'YYYY-MM-DD HH:MM:SS' with no timezone marker, but it is UTC,
// so we parse it as UTC explicitly (appending 'Z') before formatting.
// Returns the input unchanged if it can't be parsed.
function formatLocalTimestamp(utcStamp) {
  const raw = String(utcStamp || '').trim();
  if (!raw) return '';
  const parsed = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(parsed);
  } catch (_e) {
    return raw;
  }
}

function createDatabase(userDataDir) {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const filePath = path.join(userDataDir, 'quickbill.sqlite');
  // `let`, not `const`: restoreDatabase() closes this handle and reopens the
  // file, and every prepared statement below is rebuilt against the new one.
  let db = new Database(filePath);

  // Idempotent bootstrap: create the schema and apply additive migrations.
  // Re-run verbatim after a restore so a restored file always ends up on the
  // current schema, no matter which version wrote it.
  function applySchema() {
    db.exec(SCHEMA);

    // Additive migration for databases created before the frozen-currency
    // columns existed. `CREATE TABLE IF NOT EXISTS` above is a no-op on an
    // existing table, so new columns must be added explicitly.
    //
    // This only ever ADDS nullable columns. It deliberately does not backfill
    // them: writing the current profile onto historical rows would retroactively
    // assert a currency those sales may never have been rung up in. Pre-existing
    // sales fall back to the live store profile at render time (see
    // getReceiptProfile), which is the honest answer for data we cannot verify.
    const salesColumns = new Set(db.prepare(`PRAGMA table_info(sales)`).all().map(c => c.name));
    for (const col of ['currency_code', 'currency_symbol', 'locale', 'tax_label', 'store_name']) {
      if (!salesColumns.has(col)) {
        db.exec(`ALTER TABLE sales ADD COLUMN ${col} TEXT`);
      }
    }
  }
  applySchema();

  // Prepared statements (one-time compilation, reused for every call).
  // Wrapped in a function so restoreDatabase() can rebuild the whole set
  // against a freshly opened file.
  function prepareStatements() {
    return {
    insert: db.prepare(`
      INSERT INTO products (barcode, sku, name, category, cost_price, selling_price, stock_quantity, min_stock_level)
      VALUES (@barcode, @sku, @name, @category, @cost_price, @selling_price, @stock_quantity, @min_stock_level)
    `),
    update: db.prepare(`
      UPDATE products SET
        barcode         = @barcode,
        sku             = @sku,
        name            = @name,
        category        = @category,
        cost_price      = @cost_price,
        selling_price   = @selling_price,
        stock_quantity  = @stock_quantity,
        min_stock_level = @min_stock_level
      WHERE id = @id
    `),
    delete:        db.prepare(`DELETE FROM products WHERE id = ?`),
    findById:      db.prepare(`SELECT * FROM products WHERE id = ?`),
    findByBarcode: db.prepare(`SELECT * FROM products WHERE barcode = ?`),
    listAll:       db.prepare(`
      SELECT id, barcode, sku, name, category,
             cost_price, selling_price, stock_quantity, min_stock_level, created_at
      FROM products
      ORDER BY name COLLATE NOCASE
    `),
    listCategories: db.prepare(`
      SELECT DISTINCT category FROM products ORDER BY category COLLATE NOCASE
    `),
    countLowStock: db.prepare(`
      SELECT COUNT(*) AS n FROM products WHERE stock_quantity <= min_stock_level
    `),

    // ---- Phase 4 — sales / settings / idempotency ----
    decrementStock: db.prepare(`
      UPDATE products
      SET    stock_quantity = stock_quantity - @qty
      WHERE  id = @id
        AND  stock_quantity >= @qty
    `),
    readProductForUpdate: db.prepare(`
      SELECT id, barcode, sku, name, category,
             cost_price, selling_price, stock_quantity, min_stock_level, created_at
      FROM   products
      WHERE  id = @id
    `),
    findSaleById: db.prepare(`SELECT * FROM sales WHERE id = ?`),
    findSaleByBillNumber: db.prepare(`SELECT * FROM sales WHERE bill_number = ?`),
    findIdempotency: db.prepare(`
      SELECT s.* FROM idempotency i
      JOIN   sales        s ON s.id = i.sale_id
      WHERE  i.client_request_id = ?
    `),
    listSaleItemsBySaleId: db.prepare(`
      SELECT id, sale_id, product_id, product_barcode, product_sku, product_name,
             unit_price_paise, quantity, line_total_paise
      FROM   sale_items
      WHERE  sale_id = ?
      ORDER  BY id ASC
    `),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    setSetting: db.prepare(`
      INSERT INTO settings (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    };
  }
  let stmts = prepareStatements();

  function normalise(input) {
    return {
      barcode:         String(input.barcode).trim(),
      sku:             String(input.sku).trim(),
      name:            String(input.name).trim(),
      category:        (input.category && String(input.category).trim()) || 'General',
      cost_price:      Number(input.cost_price),
      selling_price:   Number(input.selling_price),
      stock_quantity:  Number(input.stock_quantity),
      min_stock_level: Number(input.min_stock_level)
    };
  }

  function listProducts({ search = '', category = '' } = {}) {
    // Build the WHERE clause with parameters; never string-concat user data.
    const where = [];
    const params = {};
    if (search && String(search).trim()) {
      where.push('(name LIKE @q OR sku LIKE @q OR barcode LIKE @q)');
      params.q = `%${String(search).trim()}%`;
    }
    if (category && category !== 'All') {
      where.push('category = @category');
      params.category = category;
    }
    const sql = `
      SELECT id, barcode, sku, name, category,
             cost_price, selling_price, stock_quantity, min_stock_level, created_at
      FROM products
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY name COLLATE NOCASE
    `;
    return db.prepare(sql).all(params);
  }

  function getProduct(id) {
    return stmts.findById.get(id) || null;
  }

  function addProduct(input) {
    const validation = validateProductInput(input);
    if (!validation.ok) {
      const e = new Error('Validation failed');
      e.code = 'VALIDATION';
      e.errors = validation.errors;
      throw e;
    }
    const data = normalise(input);
    try {
      const info = stmts.insert.run(data);
      return getProduct(info.lastInsertRowid);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(err.message)) {
        const e = new Error(
          err.message.includes('barcode')
            ? `Barcode "${data.barcode}" is already in use.`
            : `SKU "${data.sku}" is already in use.`
        );
        e.code = 'DUPLICATE';
        e.field = err.message.includes('barcode') ? 'barcode' : 'sku';
        throw e;
      }
      throw err;
    }
  }

  function updateProduct(input) {
    const validation = validateProductInput(input, { isUpdate: true });
    if (!validation.ok) {
      const e = new Error('Validation failed');
      e.code = 'VALIDATION';
      e.errors = validation.errors;
      throw e;
    }
    const existing = stmts.findById.get(input.id);
    if (!existing) {
      const e = new Error(`Product #${input.id} not found.`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const data = { id: Number(input.id), ...normalise(input) };
    try {
      stmts.update.run(data);
      return getProduct(data.id);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(err.message)) {
        const e = new Error(
          err.message.includes('barcode')
            ? `Barcode "${data.barcode}" is already in use by another product.`
            : `SKU "${data.sku}" is already in use by another product.`
        );
        e.code = 'DUPLICATE';
        e.field = err.message.includes('barcode') ? 'barcode' : 'sku';
        throw e;
      }
      throw err;
    }
  }

  function deleteProduct(id) {
    let info;
    try {
      info = stmts.delete.run(id);
    } catch (err) {
      // `sale_items.product_id` is ON DELETE RESTRICT, so a product that has
      // ever been sold cannot be removed — SQLite surfaces that as a bare
      // foreign-key violation. Translate it into an actionable message
      // instead of leaking "FOREIGN KEY constraint failed" to the cashier.
      //
      // Both codes are checked: SQLite ≥ 3.32 reports an immediate FK
      // violation as SQLITE_CONSTRAINT_TRIGGER (the generic extended-code
      // path), while older builds used the more specific FOREIGNKEY code.
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
          err.code === 'SQLITE_CONSTRAINT_TRIGGER' ||
          /FOREIGN KEY constraint failed/i.test(err.message || '')) {
        const sold = db.prepare(
          `SELECT COUNT(*) AS n FROM sale_items WHERE product_id = ?`
        ).get(id).n;
        const product = stmts.findById.get(id);
        const label = product ? `"${product.name}" (${product.sku})` : `#${id}`;
        const e = new Error(
          sold > 0
            ? `${label} appears on ${sold} past invoice${sold === 1 ? '' : 's'} and cannot be deleted — deleting it would corrupt the sales ledger. Set its stock to 0 instead.`
            : `${label} is referenced by other records and cannot be deleted.`
        );
        e.code = 'PRODUCT_IN_USE';
        e.field = 'id';
        throw e;
      }
      throw err;
    }
    if (info.changes === 0) {
      const e = new Error(`Product #${id} not found.`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    return { id: Number(id), deleted: true };
  }

  function getCategories() {
    const fromProducts = stmts.listCategories.all().map(r => r.category);
    // Merge known categories too so the dropdown is helpful on a fresh DB.
    const set = new Set([...SAMPLE_CATEGORIES, ...fromProducts]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  function getLowStock() {
    return db.prepare(`
      SELECT id, barcode, sku, name, category,
             cost_price, selling_price, stock_quantity, min_stock_level, created_at
      FROM products
      WHERE stock_quantity <= min_stock_level
      ORDER BY (stock_quantity - min_stock_level) ASC, name COLLATE NOCASE
    `).all();
  }

  function countLowStock() {
    return stmts.countLowStock.get().n;
  }

  // Idempotent seeder: skip rows whose barcode already exists, then return
  // a summary so the UI can report what changed.
  function seedSampleProducts() {
    const existing = new Set(
      db.prepare(`SELECT barcode FROM products`).all().map(r => r.barcode)
    );
    let inserted = 0;
    let skipped  = 0;
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        if (existing.has(row.barcode)) { skipped++; continue; }
        stmts.insert.run({
          barcode:         row.barcode,
          sku:             row.sku,
          name:            row.name,
          category:        row.category,
          cost_price:      row.cost_price,
          selling_price:   row.selling_price,
          stock_quantity:  row.stock_quantity,
          min_stock_level: row.min_stock_level
        });
        inserted++;
      }
    });
    insertMany(SAMPLE_PRODUCTS);
    return { inserted, skipped, total: SAMPLE_PRODUCTS.length };
  }

  // -------------------------------------------------------------------------
  // Phase 4 — checkout helpers
  // -------------------------------------------------------------------------

  // Allowed: positive integer paise, decimal rupee string parsed by
  // money.parseAmount, or a plain integer-as-string. We deliberately
  // interpret **plain numbers as integer paise** because the IPC contract
  // calls these fields `*_paise`. To pass rupees, the caller can send a
  // decimal string ("12.50") which we round-trip through the money module.
  function toPaiseFlexible(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('Amount must be a non-negative finite number.');
      }
      return Math.trunc(value);
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if (s === '') return 0;
      if (/^\d+$/.test(s)) return Number(s);
      return money.parseAmount(s);
    }
    throw new Error('Unsupported amount value.');
  }

  function normaliseCheckoutItem(raw, idx) {
    if (!raw || typeof raw !== 'object') {
      throw makeValidationError(`Item #${idx + 1} is invalid.`, { items: 'invalid' });
    }
    const barcode = String(raw.barcode ?? '').trim();
    if (!barcode) {
      throw makeValidationError(
        `Item #${idx + 1} has no barcode.`,
        { items: { row: idx, field: 'barcode', message: 'Barcode is required.' } }
      );
    }
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw makeValidationError(
        `Item #${idx + 1} (${barcode}) has an invalid quantity.`,
        { items: { row: idx, field: 'quantity', message: 'Quantity must be a whole number ≥ 1.' } }
      );
    }
    return { barcode, quantity };
  }

  function makeValidationError(message, fieldErrors) {
    const e = new Error(message);
    e.code = 'VALIDATION';
    e.errors = fieldErrors;
    return e;
  }

  // Build a bill number of the form INV-YYYYMMDD-####, scoped to `dayKey`
  // (a LOCAL `YYYY-MM-DD` day; defaults to today). Returns null if the
  // `day_serial` row already occupies this number (caller must retry on a
  // fresh serial).
  //
  // The day is a parameter rather than "always now" because the demo seeder
  // books backdated bills: an invoice rung up on the 3rd must read
  // INV-2026 1003 -####, not today's date with a historical timestamp.
  function generateBillNumber(dayKey = localTodayIso()) {
    const [yyyy, mm, dd] = String(dayKey).split('-');
    // Seed the serial from the number of sales already booked that day, then
    // probe upwards. The serial must ADVANCE on each attempt: recomputing
    // `countSalesForDay(dayKey) + 1` inside the loop returns the same value
    // every time (nothing is inserted between attempts), so a single
    // collision would retry identically MAX_BILL_NUMBER_RETRIES times and
    // then fail. A collision is reachable in practice when a bill number for
    // the day is already taken by a row whose created_at sits on a different
    // local day — e.g. a database synced from another machine, a clock
    // change, or a backdated correction.
    const startSerial = countSalesForDay(dayKey);
    for (let attempt = 0; attempt < MAX_BILL_NUMBER_RETRIES; attempt++) {
      const serial = startSerial + 1 + attempt;
      const billNumber = `${BILL_NUMBER_PREFIX}-${yyyy}${mm}${dd}-${String(serial).padStart(BILL_NUMBER_PAD, '0')}`;
      const collision = stmts.findSaleByBillNumber.get(billNumber);
      if (!collision) return billNumber;
    }
    const e = new Error('Could not allocate a unique bill number; please retry.');
    e.code = 'BILL_NUMBER_COLLISION';
    throw e;
  }

  function countSalesForDay(dayKey) {
    // Counts all sales whose created_at falls within the LOCAL calendar day.
    // `created_at` is stored in UTC by SQLite's `datetime('now')`, so the row
    // is converted with `datetime(..., 'localtime')` before the day is
    // compared. `dayKey` is built from local parts by generateBillNumber, so
    // the serial matches the date printed on the receipt.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM sales WHERE ${LOCAL_DAY_SQL} = ?`
    ).get(dayKey);
    return Number(row?.n || 0);
  }

  // -------------------------------------------------------------------------
  // Phase 4 — settings (tax rate etc.)
  // -------------------------------------------------------------------------

  function getTaxPercent() {
    const row = stmts.getSetting.get('tax_percent');
    if (!row) return DEFAULT_TAX_PERCENT;
    const n = Number(row.value);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_TAX_PERCENT;
    return n;
  }

  function setTaxPercent(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      const e = new Error('Tax percent must be a finite number ≥ 0.');
      e.code = 'VALIDATION';
      e.field = 'tax_percent';
      throw e;
    }
    stmts.setSetting.run({ key: 'tax_percent', value: String(n) });
    return n;
  }

  function getStoreSettings() {
    // Read every known key out of the settings table in one quick pass,
    // then merge over the defaults so a fresh DB still produces a fully
    // populated profile. `tax_percent` is its own key historically, so
    // we read it explicitly to keep backward compatibility.
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const map = new Map(rows.map(r => [r.key, r.value]));
    function pick(key, fallback) {
      const v = map.get(key);
      if (v === undefined || v === null || v === '') return fallback;
      return v;
    }
    const profile = {
      storeName:      pick('store_name',      DEFAULT_STORE_PROFILE.storeName),
      storeAddress:   pick('store_address',   DEFAULT_STORE_PROFILE.storeAddress),
      storePhone:     pick('store_phone',     DEFAULT_STORE_PROFILE.storePhone),
      storeEmail:     pick('store_email',     DEFAULT_STORE_PROFILE.storeEmail),
      gstin:          pick('gstin',           DEFAULT_STORE_PROFILE.gstin),
      currencyCode:   pick('currency_code',   DEFAULT_STORE_PROFILE.currencyCode),
      currencySymbol: pick('currency_symbol', DEFAULT_STORE_PROFILE.currencySymbol),
      locale:         pick('locale',          DEFAULT_STORE_PROFILE.locale),
      taxLabel:       pick('tax_label',       DEFAULT_STORE_PROFILE.taxLabel),
      invoicePrefix:  pick('invoice_prefix',  DEFAULT_STORE_PROFILE.invoicePrefix),
      receiptFooter:  pick('receipt_footer',  DEFAULT_STORE_PROFILE.receiptFooter),
      taxPercent:     getTaxPercent()
    };
    // Make sure patterns that haven't been configured still match the
    // last-known defaults: invoice prefix must be uppercase letters/numbers
    // and should mirror the persisted BILL_NUMBER_PREFIX at the DB level.
    if (typeof profile.invoicePrefix !== 'string' || !profile.invoicePrefix) {
      profile.invoicePrefix = DEFAULT_STORE_PROFILE.invoicePrefix;
    }
    if (typeof profile.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(profile.currencyCode)) {
      profile.currencyCode = DEFAULT_STORE_PROFILE.currencyCode;
    }
    if (typeof profile.locale !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(profile.locale)) {
      profile.locale = DEFAULT_STORE_PROFILE.locale;
    }
    return profile;
  }

  function validateStoreProfile(input, { partial = false } = {}) {
    const errors = {};
    const data = {};
    if (!input || typeof input !== 'object') {
      return { ok: false, errors: { _form: 'Settings payload missing.' }, data: {} };
    }
    for (const [field, rule] of Object.entries(STORE_PROFILE_FIELDS)) {
      let raw = input[field];
      if (raw === undefined || raw === null) {
        if (partial) continue;
        if (rule.required) errors[field] = 'Required';
        continue;
      }
      if (typeof raw !== 'string') {
        errors[field] = 'Must be text.';
        continue;
      }
      let v = raw;
      if (rule.trim) v = v.trim();
      if (rule.required && !v) {
        errors[field] = 'Required';
        continue;
      }
      if (v && v.length > rule.max) {
        errors[field] = `Must be ${rule.max} characters or fewer.`;
        continue;
      }
      if (rule.pattern && v && !rule.pattern.test(v)) {
        errors[field] = 'Format is invalid.';
        continue;
      }
      data[field] = v;
    }
    // Validate taxPercent if supplied in the same payload.
    if (input.taxPercent !== undefined && input.taxPercent !== null && input.taxPercent !== '') {
      const n = Number(input.taxPercent);
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        errors.taxPercent = 'Must be a number between 0 and 1000.';
      } else {
        data.taxPercent = n;
      }
    }
    return { ok: Object.keys(errors).length === 0, errors, data };
  }

  function setStoreProfile(input) {
    const validation = validateStoreProfile(input, { partial: true });
    if (!validation.ok) {
      const e = new Error('Store settings are invalid. Please review the highlighted fields.');
      e.code = 'VALIDATION';
      e.errors = validation.errors;
      throw e;
    }
    const data = validation.data;
    // Apply inside a single transaction so an interrupted write doesn't
    // leave half a profile persisted.
    const tx = db.transaction(() => {
      const setters = [
        ['store_name',      'storeName'],
        ['store_address',   'storeAddress'],
        ['store_phone',     'storePhone'],
        ['store_email',     'storeEmail'],
        ['gstin',           'gstin'],
        ['currency_code',   'currencyCode'],
        ['currency_symbol', 'currencySymbol'],
        ['locale',          'locale'],
        ['tax_label',       'taxLabel'],
        ['invoice_prefix',  'invoicePrefix'],
        ['receipt_footer',  'receiptFooter']
      ];
      for (const [key, field] of setters) {
        if (data[field] !== undefined) {
          stmts.setSetting.run({ key, value: data[field] });
        }
      }
      if (data.taxPercent !== undefined) {
        stmts.setSetting.run({ key: 'tax_percent', value: String(data.taxPercent) });
      }
    });
    tx();
    return getStoreSettings();
  }

  function getReceiptProfile({ sale } = {}) {
    // Combine the persisted store profile with one-off bits derived from
    // a specific sale (bill number, created_at, line items, totals). The
    // print-friendly receipt uses this shape from both the renderer and
    // the print pipeline.
    const profile = getStoreSettings();
    if (!sale) return { store: profile, sale: null, items: [] };
    const items = Array.isArray(sale.items) ? sale.items : [];

    // Requirement 8 — a completed sale must print exactly as it was rung up.
    // The currency, locale, tax label and store name are frozen onto the row
    // at checkout, so we overlay them on the live profile here. Without this,
    // switching the store to USD silently reprints an old INR invoice as USD.
    //
    // Sales predating the frozen-currency columns have NULLs and fall back to
    // the live profile — the best available answer for unverified history.
    const frozen = {
      storeName:      sale.store_name      || profile.storeName,
      currencyCode:   sale.currency_code   || profile.currencyCode,
      currencySymbol: sale.currency_symbol || profile.currencySymbol,
      locale:         sale.locale          || profile.locale,
      taxLabel:       sale.tax_label       || profile.taxLabel
    };
    // Store contact details are not frozen: they are business identity rather
    // than transaction semantics, and an operator changing their phone number
    // should see it on reprinted paper.
    const store = { ...profile, ...frozen };
    return { store, sale, items };
  }

  // -------------------------------------------------------------------------
  // Phase 5 — dashboard + reports queries
  // -------------------------------------------------------------------------

  // Internal helper: turn the user-supplied from/to into a pair of valid
  // YYYY-MM-DD strings on the same inclusive local-calendar-day semantics the
  // rest of the app uses (see LOCAL_DAY_SQL — the stored UTC stamp is
  // converted to local before the day is compared).
  function normaliseDateRange({ from, to } = {}) {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const f = dateRe.test(String(from || '')) ? String(from) : '';
    const t = dateRe.test(String(to   || '')) ? String(to)   : '';
    return { from: f, to: t };
  }

  function getSalesSummary({ from = '', to = '' } = {}) {
    const { from: f, to: t } = normaliseDateRange({ from, to });
    const where = [];
    const params = {};
    if (f) { where.push(`${LOCAL_DAY_SQL} >= @from`); params.from = f; }
    if (t) { where.push(`${LOCAL_DAY_SQL} <= @to`);   params.to   = t; }
    const sql = `
      SELECT
        COUNT(*)                                                                  AS sale_count,
        COALESCE(SUM(total_paise), 0)                                              AS total_paise,
        COALESCE(SUM(subtotal_paise), 0)                                           AS subtotal_paise,
        COALESCE(SUM(discount_paise), 0)                                           AS discount_paise,
        COALESCE(SUM(tax_paise), 0)                                                AS tax_paise,
        COALESCE(SUM(CASE WHEN payment_status='paid'    THEN total_paise END), 0)  AS paid_paise,
        COALESCE(SUM(CASE WHEN payment_status='unpaid'  THEN total_paise END), 0)  AS unpaid_paise,
        COALESCE(SUM(CASE WHEN payment_status='partial' THEN total_paise END), 0)  AS partial_paise,
        COALESCE(MIN(created_at), '')                                              AS first_sale_at,
        COALESCE(MAX(created_at), '')                                              AS last_sale_at,
        COALESCE(SUM(amount_received_paise), 0)                                    AS amount_received_paise,
        COALESCE(SUM(change_due_paise), 0)                                         AS change_due_paise
      FROM sales
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    const row = db.prepare(sql).get(params);
    const saleCount = Number(row.sale_count || 0);
    const totalPaise = Number(row.total_paise || 0);
    const avgTicketPaise = saleCount > 0 ? Math.trunc(totalPaise / saleCount) : 0;
    return {
      from: f,
      to:   t,
      saleCount,
      totalPaise,
      subtotalPaise:        Number(row.subtotal_paise || 0),
      discountPaise:        Number(row.discount_paise || 0),
      taxPaise:             Number(row.tax_paise || 0),
      paidPaise:            Number(row.paid_paise || 0),
      unpaidPaise:          Number(row.unpaid_paise || 0),
      partialPaise:         Number(row.partial_paise || 0),
      avgTicketPaise,
      amountReceivedPaise:  Number(row.amount_received_paise || 0),
      changeDuePaise:       Number(row.change_due_paise || 0),
      firstSaleAt:          formatLocalTimestamp(row.first_sale_at),
      lastSaleAt:           formatLocalTimestamp(row.last_sale_at)
    };
  }

  // A "daily" trend must be dense: one point per calendar day, oldest first,
  // including the days with no sales. The previous shape (`GROUP BY day` over
  // the ledger, `ORDER BY day DESC LIMIT n`) returned only days that happened
  // to contain a sale, which breaks a line chart three ways:
  //
  //   * A single-day range (the dashboard's default: today -> today) returned
  //     one point, and a one-point line has nothing to draw between its ends.
  //   * Quiet days vanished, so the x-axis silently compressed and a two-week
  //     gap looked like a one-day gap.
  //   * `limit` counted *selling* days, so the window drifted later over time.
  //
  // The window is anchored to the end of the range (`to`, else today) and is
  // always `limit` days long. `from` deliberately does NOT clamp it: this card
  // is a trailing-window sparkline, whereas the stat tiles beside it are the
  // range-scoped read. Clamping is what produced the bug — the dashboard
  // defaults to today -> today, so a clamped trend had exactly one point and
  // nothing to draw. The dashboard labels the card with the days it actually
  // plots, so the window is never hidden from the operator.
  function getSalesDailyTrend({ from = '', to = '', limit = 14 } = {}) {
    const { from: f, to: t } = normaliseDateRange({ from, to });
    const cap = Math.max(1, Math.min(366, Number(limit) || 14));

    const endKey = t || localTodayIso();
    const endDate = dayKeyToLocalDate(endKey);
    if (!endDate) return [];
    if (f && f > endKey) return [];   // range starts after it ends: nothing to plot

    const rows = db.prepare(`
      SELECT ${LOCAL_DAY_SQL} AS day,
             COUNT(*)                      AS sale_count,
             COALESCE(SUM(total_paise), 0) AS total_paise
      FROM   sales
      WHERE  ${LOCAL_DAY_SQL} <= @end
      GROUP  BY day
    `).all({ end: endKey });

    // Zero-fill: every day in the trailing `cap`-day window gets a row, the
    // ones with no sales defaulting to zero so the series has no holes.
    const byDay = new Map(rows.map(r => [r.day, r]));
    const keys = [];
    const walker = new Date(endDate);
    for (let i = 0; i < cap; i++) {
      keys.push(localDayKey(walker));
      walker.setDate(walker.getDate() - 1);
    }
    keys.reverse();
    return keys.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        saleCount:  Number(r ? r.sale_count  : 0),
        totalPaise: Number(r ? r.total_paise : 0)
      };
    });
  }

  function getBestSellers({ from = '', to = '', limit = 10 } = {}) {
    const { from: f, to: t } = normaliseDateRange({ from, to });
    const params = {};
    const where = ['s.id IS NOT NULL'];
    if (f) { where.push(`${LOCAL_DAY_SQL_ALIASED} >= @from`); params.from = f; }
    if (t) { where.push(`${LOCAL_DAY_SQL_ALIASED} <= @to`);   params.to   = t; }
    const cap = Math.max(1, Math.min(100, Number(limit) || 10));
    const sql = `
      SELECT si.product_id                                              AS productId,
             MAX(si.product_name)                                       AS productName,
             MAX(si.product_sku)                                       AS productSku,
             MAX(si.product_barcode)                                   AS productBarcode,
             SUM(si.quantity)                                           AS quantitySold,
             SUM(si.line_total_paise)                                   AS revenuePaise,
             COUNT(DISTINCT s.id)                                       AS saleCount
      FROM   sale_items si
      JOIN   sales s ON s.id = si.sale_id
      WHERE  ${where.join(' AND ')}
      GROUP  BY si.product_id
      ORDER  BY quantitySold DESC, revenuePaise DESC, si.product_id ASC
      LIMIT  ${cap}
    `;
    return db.prepare(sql).all(params).map(r => ({
      productId:     Number(r.productId),
      productName:   String(r.productName || ''),
      productSku:    String(r.productSku  || ''),
      productBarcode:String(r.productBarcode || ''),
      quantitySold:  Number(r.quantitySold || 0),
      revenuePaise:  Number(r.revenuePaise || 0),
      saleCount:     Number(r.saleCount    || 0)
    }));
  }

  function getInventoryValuation() {
    const rows = db.prepare(`
      SELECT id, barcode, sku, name, category,
             cost_price, selling_price, stock_quantity, min_stock_level, created_at
      FROM products
      ORDER BY name COLLATE NOCASE
    `).all();
    let totalUnits = 0;
    let totalCostValuePaise = 0;
    let totalRetailValuePaise = 0;
    let lowStockCount = 0;
    const byCategory = new Map();
    for (const r of rows) {
      const qty = Number(r.stock_quantity || 0);
      const costPaise  = Math.round(Number(r.cost_price  || 0) * 100);
      const retailPaise = Math.round(Number(r.selling_price || 0) * 100);
      const lineCost = costPaise * qty;
      const lineRetail = retailPaise * qty;
      totalUnits += qty;
      totalCostValuePaise += lineCost;
      totalRetailValuePaise += lineRetail;
      if (qty <= Number(r.min_stock_level || 0)) lowStockCount++;
      const cat = String(r.category || 'General');
      const cur = byCategory.get(cat) || {
        category: cat, units: 0, costValuePaise: 0, retailValuePaise: 0, productCount: 0
      };
      cur.units += qty;
      cur.costValuePaise += lineCost;
      cur.retailValuePaise += lineRetail;
      cur.productCount += 1;
      byCategory.set(cat, cur);
    }
    const breakdown = Array.from(byCategory.values())
      .sort((a, b) => b.retailValuePaise - a.retailValuePaise);
    const items = rows.map(r => {
      const qty = Number(r.stock_quantity || 0);
      const costPaise  = Math.round(Number(r.cost_price   || 0) * 100);
      const retailPaise = Math.round(Number(r.selling_price || 0) * 100);
      const low = qty <= Number(r.min_stock_level || 0);
      return {
        ...r,
        costValuePaise:  costPaise  * qty,
        retailValuePaise: retailPaise * qty,
        lowStock: low,
        deficit: Math.max(0, Number(r.min_stock_level || 0) - qty)
      };
    });
    return {
      productCount:     rows.length,
      totalUnits,
      totalCostValuePaise,
      totalRetailValuePaise,
      lowStockCount,
      byCategory:       breakdown,
      items
    };
  }

  function listRecentSales({ from = '', to = '', limit = 8 } = {}) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 8));
    // The dashboard labels this list "Latest N invoices in range", so the
    // range is applied here rather than ignored. Bounds reuse the same local
    // day-bucketing as every other report.
    const { from: f, to: t } = normaliseDateRange({ from, to });
    const where = [];
    const params = {};
    if (f) { where.push(`${LOCAL_DAY_SQL_ALIASED} >= @from`); params.from = f; }
    if (t) { where.push(`${LOCAL_DAY_SQL_ALIASED} <= @to`);   params.to   = t; }
    return db.prepare(`
      SELECT s.id, s.bill_number, s.created_at, s.payment_method, s.payment_status,
             s.subtotal_paise, s.discount_paise, s.tax_paise, s.total_paise,
             s.cashier_name, s.customer_name,
             COALESCE(item.total_items, 0) AS item_count
      FROM   sales s
      LEFT JOIN (
        SELECT sale_id, SUM(quantity) AS total_items FROM sale_items GROUP BY sale_id
      ) item ON item.sale_id = s.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER  BY s.created_at DESC, s.id DESC
      LIMIT  ${cap}
    `).all(params).map(r => ({
      ...r,
      item_count: Number(r.item_count || 0),
      created_at_local: formatLocalTimestamp(r.created_at)
    }));
  }

  // -------------------------------------------------------------------------
  // Phase 4 — checkout
  // -------------------------------------------------------------------------

  /**
   * Run a full checkout in a single SQLite transaction.
   *
   * The renderer only passes the cart shape:
   *   { items: [{ barcode, quantity }], discountPaise, taxPercent,
   *     payment: { method, amountReceivedPaise }, clientRequestId }
   *
   * The main process is the source of truth for prices, stock and totals,
   * and commits the sale + items + stock decrement atomically.
   *
   * `internal` is a SECOND argument, deliberately out of reach of the
   * renderer's payload. `{ createdAt }` backdates the invoice (used only by
   * `seedDemoSales` to build a month of history); a checkout can never be
   * stamped into the past by anything coming through IPC.
   */
  function createSale(input, internal = {}) {
    if (!input || typeof input !== 'object') {
      throw makeValidationError('Checkout payload is missing.', { items: 'missing' });
    }
    const rawItems = Array.isArray(input.items) ? input.items : [];
    if (rawItems.length === 0) {
      throw makeValidationError('Cart is empty — add at least one product.', { items: 'empty' });
    }
    const discountPaise = (() => {
      try { return Math.max(0, toPaiseFlexible(input.discountPaise ?? 0)); }
      catch (e) { throw makeValidationError(e.message, { discountPaise: e.message }); }
    })();
    const taxPercent = (() => {
      const n = Number(input.taxPercent ?? getTaxPercent());
      if (!Number.isFinite(n) || n < 0 || n > 1000) {
        throw makeValidationError('Tax percent must be a finite number ≥ 0.', { taxPercent: 'invalid' });
      }
      return n;
    })();
    const paymentMethod = String(input.payment?.method ?? 'cash').toLowerCase();
    if (!SALE_PAYMENT_METHODS.has(paymentMethod)) {
      throw makeValidationError(`Unsupported payment method: ${paymentMethod}`, { paymentMethod: 'invalid' });
    }
    const amountReceivedPaise = (() => {
      try {
        if (paymentMethod === 'unpaid') return 0;
        return Math.max(0, toPaiseFlexible(input.payment?.amountReceivedPaise ?? 0));
      } catch (e) { throw makeValidationError(e.message, { amountReceivedPaise: e.message }); }
    })();

    // Normalise items: barcode + positive integer quantity.
    const requested = rawItems.map((r, i) => normaliseCheckoutItem(r, i));

    // Collapse duplicate barcodes (renderer might emit them separately).
    const collapsed = new Map();
    for (const it of requested) {
      const prev = collapsed.get(it.barcode);
      collapsed.set(it.barcode, prev ? prev + it.quantity : it.quantity);
    }
    const items = Array.from(collapsed.entries()).map(([barcode, quantity]) => ({ barcode, quantity }));

    // Cashier / customer / notes are trusted only as free text — they have
    // no effect on totals — so we cap length defensively and trim.
    const cashierName  = String(input.cashierName ?? '').slice(0, 80);
    const customerName = String(input.customerName ?? '').slice(0, 120);
    const notes        = String(input.notes ?? '').slice(0, 500);

    const idempotencyKey = input.clientRequestId
      ? String(input.clientRequestId).slice(0, 80)
      : null;

    // When is this invoice "happened"? Normally now. `internal.createdAt`
    // (main-process only — see the JSDoc above) backdates it for the demo
    // seeder. A renderer can never reach this branch, so a real checkout is
    // always stamped with the wall clock.
    const createdAt = ownCreatedAt(internal) || new Date();

    // Read the store profile once, outside the transaction: it is frozen onto
    // the sale so a later settings edit cannot retroactively re-label this
    // completed transaction (requirement 8).
    const profile = getStoreSettings();

    // -------------------------------------------------------------------------
    // The transaction itself: every step runs inside better-sqlite3's
    // db.transaction() wrapper. If any throw, the entire batch rolls back —
    // including stock decrements.
    // -------------------------------------------------------------------------
    const tx = db.transaction(() => {
      // Idempotency: if this client_request_id already produced a sale,
      // return the prior result and make *no* changes.
      if (idempotencyKey) {
        const prior = stmts.findIdempotency.get(idempotencyKey);
        if (prior) {
          const sale = getSale(prior.id);
          return { sale, replayed: true };
        }
      }

      // Re-read each product authoritatively inside the transaction so the
      // price + stock we use matches what we'll commit against.
      const resolved = [];
      for (const it of items) {
        const product = stmts.findByBarcode.get(it.barcode);
        if (!product) {
          const e = new Error(`Unknown barcode: ${it.barcode}. It may have been removed from the catalogue.`);
          e.code = 'PRODUCT_MISSING';
          e.field = 'barcode';
          e.barcode = it.barcode;
          throw e;
        }
        if (!Number.isInteger(product.stock_quantity) || product.stock_quantity < it.quantity) {
          const e = new Error(
            `Insufficient stock for "${product.name}" (${product.sku}). Only ${product.stock_quantity} in stock, ${it.quantity} requested.`
          );
          e.code = 'INSUFFICIENT_STOCK';
          e.barcode = product.barcode;
          e.productId = product.id;
          e.available = product.stock_quantity;
          e.requested = it.quantity;
          throw e;
        }
        const unitPricePaise = money.fromRupees(product.selling_price);
        const lineTotalPaise = money.mul(unitPricePaise, it.quantity);
        resolved.push({
          product,
          quantity: it.quantity,
          unitPricePaise,
          lineTotalPaise
        });
      }

      const subtotalPaise = resolved.reduce((s, r) => s + r.lineTotalPaise, 0);
      const discountedBase = money.applyDiscount(subtotalPaise, discountPaise);
      const taxPaise = money.mulPercent(discountedBase, taxPercent);
      const totalPaise = discountedBase + taxPaise;

      // Payment status: for "unpaid" method we always store status='unpaid'
      // and amount_received=0; for cash we derive the status from the
      // amount the cashier actually handed over.
      let paymentStatus;
      let changeDuePaise;
      let actualReceived;
      if (paymentMethod === 'unpaid') {
        paymentStatus = 'unpaid';
        changeDuePaise = 0;
        actualReceived = 0;
      } else {
        const derived = derivePaymentStatus(totalPaise, amountReceivedPaise);
        paymentStatus = derived.status;
        changeDuePaise = derived.changeDuePaise;
        actualReceived = amountReceivedPaise;
      }

      // Bill number: protected by UNIQUE on the schema. The generator scans
      // existing counts for the day this invoice is stamped with; if it loses
      // a race we let the SQLITE_CONSTRAINT_UNIQUE bubble up so the renderer
      // can retry.
      const billNumber = generateBillNumber(localDayKey(createdAt));

      // Decrement stock first so a UNIQUE / CHECK failure on sale insert
      // rolls the inventory back too.
      for (const r of resolved) {
        const info = stmts.decrementStock.run({
          id: r.product.id,
          qty: r.quantity
        });
        if (info.changes === 0) {
          // Re-read for an accurate error message, then roll back.
          const fresh = stmts.readProductForUpdate.get(r.product.id);
          const available = fresh ? fresh.stock_quantity : 0;
          const e = new Error(
            `Insufficient stock for "${r.product.name}" (${r.product.sku}). Only ${available} in stock, ${r.quantity} requested.`
          );
          e.code = 'INSUFFICIENT_STOCK';
          e.barcode = r.product.barcode;
          e.productId = r.product.id;
          e.available = available;
          e.requested = r.quantity;
          throw e;
        }
      }

      const insertSale = db.prepare(`
        INSERT INTO sales (
          bill_number, subtotal_paise, discount_paise, tax_paise, total_paise,
          tax_percent, payment_method, payment_status, amount_received_paise,
          change_due_paise, cashier_name, customer_name, notes,
          currency_code, currency_symbol, locale, tax_label, store_name,
          created_at
        ) VALUES (
          @bill_number, @subtotal_paise, @discount_paise, @tax_paise, @total_paise,
          @tax_percent, @payment_method, @payment_status, @amount_received_paise,
          @change_due_paise, @cashier_name, @customer_name, @notes,
          @currency_code, @currency_symbol, @locale, @tax_label, @store_name,
          @created_at
        )
      `).run({
        bill_number:           billNumber,
        subtotal_paise:        subtotalPaise,
        discount_paise:        discountPaise,
        tax_paise:             taxPaise,
        total_paise:           totalPaise,
        tax_percent:           taxPercent,
        payment_method:        paymentMethod,
        payment_status:        paymentStatus,
        amount_received_paise: actualReceived,
        change_due_paise:      changeDuePaise,
        cashier_name:          cashierName,
        customer_name:         customerName,
        notes:                 notes,
        // Frozen presentation context — see the `sales` schema comment.
        currency_code:         profile.currencyCode,
        currency_symbol:       profile.currencySymbol,
        locale:                profile.locale,
        tax_label:             profile.taxLabel,
        store_name:            profile.storeName,
        // Explicit UTC stamp, same shape SQLite's datetime('now') default
        // would have written. Passed rather than defaulted so a backdated
        // demo invoice lands on the day it claims.
        created_at:            toSqliteUtcStamp(createdAt)
      });
      const saleId = Number(insertSale.lastInsertRowid);

      const insertItem = db.prepare(`
        INSERT INTO sale_items (
          sale_id, product_id, product_barcode, product_sku, product_name,
          unit_price_paise, quantity, line_total_paise
        ) VALUES (
          @sale_id, @product_id, @product_barcode, @product_sku, @product_name,
          @unit_price_paise, @quantity, @line_total_paise
        )
      `);
      for (const r of resolved) {
        insertItem.run({
          sale_id:         saleId,
          product_id:      r.product.id,
          product_barcode: r.product.barcode,
          product_sku:     r.product.sku,
          product_name:    r.product.name,
          unit_price_paise: r.unitPricePaise,
          quantity:        r.quantity,
          line_total_paise: r.lineTotalPaise
        });
      }

      if (idempotencyKey) {
        db.prepare(`
          INSERT INTO idempotency (client_request_id, sale_id) VALUES (?, ?)
        `).run(idempotencyKey, saleId);
      }

      return getSale(saleId);
    });

    let result;
    try {
      // `tx.immediate()` acquires a reserved lock and runs the callback.
      const out = tx.immediate();
      // First-time checkouts get { sale, replayed: false }; idempotent
      // replays have replayed: true. If the function signature ever changes
      // we still ship a sensible fallback so the renderer always gets data.
      if (out && typeof out === 'object' && 'sale' in out) {
        result = out;
      } else {
        result = { sale: out, replayed: false };
      }
    } catch (err) {
      // Map UNIQUE constraint on bill_number to a renderer-friendly code.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /sales\.bill_number/i.test(err.message || '')) {
        const e = new Error('Could not allocate a unique bill number; please retry.');
        e.code = 'BILL_NUMBER_COLLISION';
        throw e;
      }
      throw err;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Phase 4 — sales history queries
  // -------------------------------------------------------------------------

  function getSale(id) {
    const sale = stmts.findSaleById.get(id);
    if (!sale) return null;
    const items = stmts.listSaleItemsBySaleId.all(id);
    // `created_at` is the raw UTC column (used for ordering/audit);
    // `created_at_local` is what the receipt and history rows display.
    return { ...sale, items, created_at_local: formatLocalTimestamp(sale.created_at) };
  }

  function getSaleByBillNumber(billNumber) {
    const sale = stmts.findSaleByBillNumber.get(String(billNumber));
    if (!sale) return null;
    return getSale(sale.id);
  }

  function listSales({ from = '', to = '', bill = '', q = '', limit = 200 } = {}) {
    const where = [];
    const params = {};
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push(`${LOCAL_DAY_SQL_ALIASED} >= @from`);
      params.from = from;
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push(`${LOCAL_DAY_SQL_ALIASED} <= @to`);
      params.to = to;
    }
    if (bill && String(bill).trim()) {
      where.push('s.bill_number LIKE @bill');
      params.bill = `%${String(bill).trim()}%`;
    }
    if (q && String(q).trim()) {
      where.push('(s.bill_number LIKE @q OR s.customer_name LIKE @q OR s.cashier_name LIKE @q)');
      params.q = `%${String(q).trim()}%`;
    }
    const capped = Math.max(1, Math.min(1000, Number(limit) || 200));
    const sql = `
      SELECT s.*, COALESCE(item.total_items, 0) AS item_count,
             ${LOCAL_DAY_SQL_ALIASED} AS created_at_local_day
      FROM   sales s
      LEFT JOIN (
        SELECT sale_id, SUM(quantity) AS total_items
        FROM   sale_items
        GROUP  BY sale_id
      ) item ON item.sale_id = s.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER  BY s.created_at DESC, s.id DESC
      LIMIT  ${capped}
    `;
    // `created_at_local` is the display timestamp; `created_at` stays the raw
    // UTC column so nothing downstream has to guess which is which.
    return db.prepare(sql).all(params).map(r => ({
      ...r,
      created_at_local: formatLocalTimestamp(r.created_at)
    }));
  }

  function getSalesTodaySummary() {
    // Delegate to getSalesSummary so "today" is defined in exactly one place
    // (the local calendar day) and the shape matches every other report the
    // renderer consumes. The previous hand-rolled query returned snake_case
    // keys that no view read, which is how the dashboard came to label an
    // all-time total as "bills today".
    return getSalesSummary({ from: localTodayIso(), to: localTodayIso() });
  }

  function close() { db.close(); }

  // -------------------------------------------------------------------------
  // Demo month — a month of realistic sale history
  // -------------------------------------------------------------------------
  //
  // `seedDemoSales()` books a run of backdated invoices through the SAME
  // `createSale()` checkout path the till uses: same price lookup, same tax
  // maths, same stock decrement, same bill numbering, same idempotency table.
  // Nothing is INSERTed behind createSale's back, so a demo ledger is
  // indistinguishable from a real one — every report, receipt and reprint
  // reads it through exactly the same code path.
  //
  // Two properties matter and are tested:
  //
  //   * IDEMPOTENT. Each invoice carries `clientRequestId = demo-<day>-<n>`,
  //     so re-running replays instead of duplicating. Which days are already
  //     filled is read back from the `idempotency` table — the ledger itself
  //     is the only record of what exists, so a restored backup or a deleted
  //     settings row can never convince the seeder to double-book a day.
  //
  //   * STOCK-SAFE. A month of trading drains a 15-item catalogue many times
  //     over. Before booking anything the seeder raises each product's stock
  //     to cover the demand it is about to generate (plus the reorder level),
  //     so no invoice is rejected for insufficient stock. The uplift is
  //     reported back as `restocked` so the caller can say so out loud —
  //     demo data is not allowed to silently edit inventory.
  //
  // The plan is generated from a seeded PRNG keyed on the day, so the same
  // database + same day always produce the same invoices. That is what makes
  // the numbers in a screenshot stable and the test assertions meaningful.

  const DEMO_SEED_MAX_DAYS = 90;
  const DEMO_SEED_DEFAULT_DAYS = 30;

  // Cashiers and regulars used by the demo ledger. Deliberately generic
  // names — demo receipts should not invent customers who look real.
  const DEMO_CASHIERS = ['A. Rao', 'S. Iyer', 'M. Khan'];
  const DEMO_CUSTOMERS = [
    'Walk-in', 'Walk-in', 'Walk-in', 'Walk-in', 'Walk-in', 'Walk-in',
    'R. Nair', 'P. Desai', 'K. Menon', 'L. Fernandes', 'T. Ali', 'J. Bose'
  ];
  const DEMO_NOTES = ['', '', '', '', '', '', '', '', '', '', 'Thank you!', 'Bulk order'];

  // mulberry32 — tiny, fast, deterministic. Seeded per day so each day's
  // invoices depend only on that day, never on how many ran before.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function daySeed(dayKey, salt) {
    let h = 2166136261 >>> 0;
    for (const ch of `${dayKey}#${salt}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Deterministic 0..1 from a product id — used to vary the leftover stock
  // headroom so the shelf doesn't end up uniform.
  function randStock(id) {
    let x = (Number(id) * 2654435761) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 2246822519);
    x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  }

  // Pick `n` distinct products, weighted so cheap staples (water, snacks)
  // turn over faster than expensive ones (detergent, oil) — which is what
  // actually happens in a neighbourhood supermarket.
  function pickProducts(products, rand, n) {
    const pool = products.map((p) => {
      const price = Math.max(0, Number(p.selling_price || 0));
      // Weight falls off with price: ₹1 water is bought constantly, ₹9
      // detergent is not. A zero-priced item (legal under
      // validateProductInput when cost is also 0) is a giveaway, not a
      // fast-moving staple, so it is weighted BELOW every paid product. The
      // raw 4/(1+price) curve peaks at 4 for price 0, which made free items
      // the single most likely thing in every basket — producing all-free
      // baskets totalling ₹0, the exact outcome the discount cap below
      // exists to prevent.
      const weight = price > 0
        ? 4 / (1 + price)
        : 0.25;
      return { p, weight, key: rand() };
    });
    pool.sort((a, b) => b.key - a.key);
    const chosen = [];
    let totalWeight = pool.reduce((s, e) => s + e.weight, 0);
    for (let i = 0; i < n && pool.length > 0; i++) {
      let ticket = rand() * totalWeight;
      let idx = 0;
      for (let j = 0; j < pool.length; j++) {
        ticket -= pool[j].weight;
        if (ticket <= 0) { idx = j; break; }
        idx = j;
      }
      chosen.push(pool[idx].p);
      totalWeight -= pool[idx].weight;
      pool.splice(idx, 1);
    }
    return chosen;
  }

  /**
   * Book a month of demo sale history.
   *
   * @param {object} [options]
   * @param {number} [options.days=30]  How many days back to cover, 1..90.
   * @returns {{inserted:number, replayed:number, days:number, from:string,
   *            to:string, restocked:number, totalPaise:number}}
   */
  function seedDemoSales(options = {}) {
    const raw = Number(options && options.days != null ? options.days : DEMO_SEED_DEFAULT_DAYS);
    if (!Number.isInteger(raw) || raw < 1 || raw > DEMO_SEED_MAX_DAYS) {
      throw makeValidationError(
        `Demo history must cover between 1 and ${DEMO_SEED_MAX_DAYS} days.`,
        { days: 'invalid' }
      );
    }

    const products = stmts.listAll.all();
    if (products.length === 0) {
      // A ledger without a catalogue cannot exist — and silently seeding
      // products here would hide that the operator never built one.
      const e = new Error(
        'Add sample products first (Products → Add sample products), then load the demo month.'
      );
      e.code = 'NO_PRODUCTS';
      throw e;
    }

    const today = new Date();
    const taxPercent = getTaxPercent();

    // Which days already hold demo invoices? Ask the ledger rather than a
    // bookkeeping row: every demo invoice writes an idempotency key of the
    // form `demo-YYYY-MM-DD-<n>`, so a day is filled iff at least one key
    // for it exists. That keeps the seeder correct across a restored backup
    // or a hand-edited settings table — neither of which a single "last
    // day" marker can survive.
    //
    // TODAY is the exception. Its invoices are drawn from the trading hours
    // that have actually elapsed, so its target count GROWS as the day runs:
    // seeding at 09:00 books a morning's worth, and clicking again at 17:00
    // tops the day up to a full day's trade. Skipping it outright would
    // freeze today's dashboard tile at whatever the first click saw. Past
    // days are complete the moment they are written, so they are all-or-
    // nothing.
    const todayKey = localDayKey(today);
    const bookedToday = db.prepare(
      `SELECT COUNT(*) AS n FROM idempotency
       WHERE client_request_id >= @lo AND client_request_id < @hi`
    ).get({ lo: `demo-${todayKey}-`, hi: `demo-${todayKey}.` }).n;

    const days = [];
    let lastFilledDay = '';
    for (let back = raw - 1; back >= 0; back--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      const key = localDayKey(d);
      if (key === todayKey) {
        days.push({ key, date: d, partial: true });
        continue;
      }
      const existing = db.prepare(
        // A prefix range, not LIKE: `client_request_id LIKE 'demo-D-…%'`
        // cannot use the primary-key index and degrades into a full scan of
        // the idempotency table. Half-open range on the same prefix seeks it.
        `SELECT 1 AS hit FROM idempotency
         WHERE client_request_id >= @lo AND client_request_id < @hi
         LIMIT 1`
      ).get({ lo: `demo-${key}-`, hi: `demo-${key}.` });
      if (existing) {
        if (key > lastFilledDay) lastFilledDay = key;
        continue;
      }
      days.push({ key, date: d, partial: false });
    }

    // ---- Phase A: plan every invoice before touching stock ----------------
    //
    // Planning up front is what makes the stock uplift safe: we know the
    // exact per-product demand, so each product is topped up to cover its own
    // demand plus its reorder level, and nothing is raised by accident.
    const plan = [];
    const demandByBarcode = new Map();

    for (const day of days) {
      const rand = mulberry32(daySeed(day.key, 'sales'));
      const dow = day.date.getDay();                       // 0 = Sunday
      const isWeekend = dow === 0 || dow === 6;
      // Busier at weekends, quietest midweek — the shape every grocery
      // trade curve has. Jitter is bounded so no day looks synthetic.
      const base = isWeekend ? 14 : 9;
      let count = Math.max(3, Math.round(base + rand() * base));

      // Today only fills in proportion to the trading day that has actually
      // happened, and never rewrites what is already on the ledger: invoice
      // indices below `bookedToday` replay through createSale's idempotency
      // check, so a later click adds the afternoon without touching the
      // morning.
      let startIndex = 0;
      if (day.partial) {
        const openedAt = new Date(day.date);
        openedAt.setHours(8, 0, 0, 0);
        const closedAt = new Date(day.date);
        closedAt.setHours(21, 0, 0, 0);
        const elapsed = Math.min(1, Math.max(0,
          (today.getTime() - openedAt.getTime()) / (closedAt.getTime() - openedAt.getTime())));
        // At least 1, so a pre-dawn click still puts something on today.
        count = Math.max(1, Math.ceil(count * elapsed));
        startIndex = Math.min(bookedToday, count);
      }

      for (let i = startIndex; i < count; i++) {
        const lines = 1 + Math.floor(rand() * rand() * 5);   // skewed to 1–2 lines
        const picked = pickProducts(products, mulberry32(daySeed(day.key, `cart-${i}`)), lines);

        const items = [];
        let subtotalPaise = 0;
        for (const p of picked) {
          // Quantity: mostly 1–2, occasionally a bulk buy.
          const roll = rand();
          const quantity = roll < 0.68 ? 1 : roll < 0.90 ? 2 : roll < 0.98 ? 3 : 5;
          const unitPricePaise = money.fromRupees(p.selling_price);
          subtotalPaise += money.mul(unitPricePaise, quantity);
          items.push({ barcode: p.barcode, quantity });
          demandByBarcode.set(
            p.barcode,
            (demandByBarcode.get(p.barcode) || 0) + quantity
          );
        }

        // Discount: mostly none, sometimes a flat ₹5/₹10/₹20 off — but never
        // more than a quarter of the basket. A single ₹1.20 item would
        // otherwise be discounted to nothing, producing a zero-total invoice
        // that no real till would print.
        let discountPaise = 0;
        if (rand() < 0.18) {
          const wanted = [500, 1000, 2000][Math.floor(rand() * 3)];
          const cap = Math.floor(subtotalPaise / 4);
          discountPaise = Math.min(wanted, cap);
        }

        // Tax: the shop's configured rate, so demo receipts agree with
        // whatever the operator has set in Settings.
        const taxPaise = money.mulPercent(
          money.applyDiscount(subtotalPaise, discountPaise), taxPercent
        );
        const totalPaise = money.applyDiscount(subtotalPaise, discountPaise) + taxPaise;

        // Payment: mostly cash tendered as the next round note up (so bills
        // carry realistic change due), a slice exact, and a few on credit.
        let method = 'cash';
        let amountReceivedPaise = totalPaise;
        const payRoll = rand();
        if (payRoll < 0.08) {
          method = 'unpaid';
          amountReceivedPaise = 0;
        } else if (payRoll < 0.42) {
          const notePaise = [500, 1000, 2000][Math.floor(rand() * 3)];
          amountReceivedPaise = Math.ceil(totalPaise / notePaise) * notePaise;
        } else if (payRoll < 0.50 && totalPaise >= 4) {
          // Part-paid: gives the Reports screen a non-zero "partial" bucket.
          // Skipped on trivially small baskets, where halving the tender
          // rounds to zero and the sale would silently become "unpaid".
          amountReceivedPaise = Math.floor(totalPaise / 2);
        }

        // Trading hours 08:00–21:00, busiest late afternoon. For past days the
        // stamp is taken as drawn; for TODAY the whole day has not happened
        // yet, so stamps are compressed into the hours that have actually
        // elapsed. Clamping every one of them to "now" instead would give
        // the entire day a single identical timestamp.
        const at = new Date(day.date);
        const dayIsToday = day.key === localDayKey(today);
        if (dayIsToday) {
          // Spread across the part of TODAY that has actually elapsed. Before
          // the shop opens (or in the sliver after midnight) that window is
          // measured from midnight instead — pinning every invoice to "now"
          // would stamp the whole day with one identical time.
          const windowStart = new Date(day.date);
          windowStart.setHours(8, 0, 0, 0);
          if (windowStart.getTime() > today.getTime()) windowStart.setHours(0, 0, 0, 0);
          const span = today.getTime() - windowStart.getTime();
          at.setTime(span > 0
            ? windowStart.getTime() + Math.floor(rand() * span)
            : today.getTime());
        } else {
          const minuteOfDay = (8 * 60) + Math.floor(rand() * (13 * 60));
          at.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
        }

        plan.push({
          dayKey: day.key,
          clientRequestId: `demo-${day.key}-${i}`,
          createdAt: at,
          items,
          discountPaise,
          taxPercent,
          payment: { method, amountReceivedPaise },
          cashierName: DEMO_CASHIERS[Math.floor(rand() * DEMO_CASHIERS.length)],
          customerName: DEMO_CUSTOMERS[Math.floor(rand() * DEMO_CUSTOMERS.length)],
          notes: DEMO_NOTES[Math.floor(rand() * DEMO_NOTES.length)],
          totalPaise
        });
      }
    }

    // Nothing to book: every day is already filled (or today has already
    // reached its elapsed-hours target). Reported honestly rather than
    // running an empty transaction.
    if (plan.length === 0) {
      return {
        inserted: 0, replayed: 0, days: 0,
        from: todayKey, to: todayKey,
        restocked: 0, totalPaise: 0
      };
    }

    // ---- Phase B: stock uplift, then book, in one transaction -------------
    //
    // A single transaction for the whole month: if anything fails, the operator
    // gets none of it rather than a half-seeded ledger.
    let inserted = 0;
    let replayed = 0;
    let totalPaise = 0;
    const restocked = [];

    const run = db.transaction(() => {
      for (const p of products) {
        const demand = demandByBarcode.get(p.barcode) || 0;
        if (demand === 0) continue;
        const reorder = Number(p.min_stock_level || 0);
        // Cover the month AND leave a little stock on the shelf afterwards.
        // Topping up to exactly `demand + reorder` would end every product
        // precisely on its reorder level, which paints the whole catalogue
        // red and pins the Inventory badge at "everything low" — a state no
        // real shop sits in once a month of trading is over.
        const headroom = 2 + Math.floor(randStock(p.id) * 6);
        const needed = demand + reorder + headroom;
        if (Number(p.stock_quantity) >= needed) continue;
        stmts.update.run({
          id: p.id, barcode: p.barcode, sku: p.sku, name: p.name,
          category: p.category, cost_price: p.cost_price,
          selling_price: p.selling_price,
          stock_quantity: needed, min_stock_level: reorder
        });
        restocked.push(p.sku);
      }

      for (const s of plan) {
        const result = createSale(s, { createdAt: s.createdAt });
        if (result.replayed) replayed++;
        else {
          inserted++;
          totalPaise += Number(result.sale.total_paise || 0);
        }
      }
    });
    run.immediate();

    return {
      inserted,
      replayed,
      // Days that actually received a NEW invoice — not the size of the
      // requested window. Today is always re-examined (it grows with the
      // clock), so counting it here would report a day filled when the
      // elapsed-hours target had already been met and nothing was written.
      days: new Set(plan.map((s) => s.dayKey)).size,
      from: days[0].key,
      to: days[days.length - 1].key,
      restocked: restocked.length,
      totalPaise
    };
  }

  // -------------------------------------------------------------------------
  // Backup / restore
  //
  // The ledger is the shop's books. A POS that can be backed up in one click
  // and restored in one click is materially safer than one where the only
  // recovery path is "find quickbill.sqlite in ~/Library/Application Support".
  //
  // `backup()` (better-sqlite3's online backup API) is used rather than
  // `fs.copyFile` because the database runs in WAL mode: a raw copy of the
  // main file alone can miss transactions still sitting in the -wal sidecar,
  // silently truncating the ledger. The online backup API checkpoints those
  // pages into the destination as it goes.
  // -------------------------------------------------------------------------

  async function backupDatabase(destinationPath) {
    const dest = String(destinationPath || '').trim();
    if (!dest) {
      const e = new Error('No destination path was chosen.');
      e.code = 'VALIDATION';
      throw e;
    }
    const info = await db.backup(dest);
    const bytes = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    return { filePath: dest, pages: Number(info?.totalPages || 0), bytes };
  }

  // Read-only inspection of a candidate restore file. Never mutates it, and
  // never runs a migration against it — we only need to know it is a
  // QuickBill database and roughly how much it holds, so the operator can
  // confirm before anything is overwritten.
  function inspectDatabase(sourcePath) {
    const src = String(sourcePath || '').trim();
    if (!src) {
      const e = new Error('No source path was chosen.');
      e.code = 'VALIDATION';
      throw e;
    }
    if (!fs.existsSync(src)) {
      const e = new Error(`That file no longer exists: ${src}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!fs.statSync(src).isFile()) {
      const e = new Error('That path is not a file.');
      e.code = 'VALIDATION';
      throw e;
    }
    let probe = null;
    try {
      probe = new Database(src, { readonly: true, fileMustExist: true });
      // Force the header/page cache to actually touch the file: a random
      // non-database is rejected here, before we overwrite anything.
      const tables = new Set(
        probe.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name)
      );
      if (!tables.has('products') || !tables.has('sales')) {
        const e = new Error('That file is not a QuickBill database (no products/sales tables).');
        e.code = 'NOT_A_QUICKBILL_DB';
        throw e;
      }
      const productCount  = Number(probe.prepare(`SELECT COUNT(*) AS n FROM products`).get().n);
      const saleCount     = Number(probe.prepare(`SELECT COUNT(*) AS n FROM sales`).get().n);
      const itemCount     = tables.has('sale_items')
        ? Number(probe.prepare(`SELECT COUNT(*) AS n FROM sale_items`).get().n) : 0;
      const lastSale      = tables.has('sales')
        ? (probe.prepare(`SELECT MAX(created_at) AS m FROM sales`).get().m || '') : '';
      return {
        filePath: src,
        bytes: fs.statSync(src).size,
        productCount,
        saleCount,
        itemCount,
        lastSaleAt: formatLocalTimestamp(lastSale),
        schemaVersion: productsSchemaColumns(probe).join(',')
      };
    } catch (err) {
      if (err.code === 'NOT_A_QUICKBILL_DB') throw err;
      const e = new Error(`That file could not be read as a SQLite database: ${err.message}`);
      e.code = 'INVALID_BACKUP';
      throw e;
    } finally {
      if (probe) { try { probe.close(); } catch (_e) { /* ignore */ } }
    }
  }

  function productsSchemaColumns(handle) {
    return handle.prepare(`PRAGMA table_info(products)`).all().map(c => c.name);
  }

  // Replace the live database with `sourcePath`.
  //
  // Ordering matters: the current handle is closed FIRST (which checkpoints
  // and removes the -wal/-shm sidecars), then the current file is copied
  // aside as a recovery net, and only then is the source copied into place.
  // If anything throws after the close, the old handle is reopened so the
  // app keeps working instead of dying with a null database.
  function restoreDatabase(sourcePath) {
    const src = String(sourcePath || '').trim();
    const inspection = inspectDatabase(src);
    if (path.resolve(src) === path.resolve(filePath)) {
      const e = new Error('That is already the database QuickBill is using.');
      e.code = 'VALIDATION';
      throw e;
    }

    const safetyCopy = `${filePath}.pre-restore`;
    db.close();
    try {
      // Recovery net: if the copy below is interrupted, the previous ledger
      // is still on disk under this name.
      if (fs.existsSync(filePath)) fs.copyFileSync(filePath, safetyCopy);
      fs.copyFileSync(src, filePath);
      // A stale -wal from the old database would be replayed on top of the
      // restored file and corrupt it.
      for (const suffix of ['-wal', '-shm']) {
        fs.rmSync(`${filePath}${suffix}`, { force: true });
      }
      db = new Database(filePath);
      applySchema();
      stmts = prepareStatements();
    } catch (err) {
      // Reopen whatever is on disk so the app stays usable.
      try { db = new Database(filePath); applySchema(); stmts = prepareStatements(); }
      catch (_openErr) { throw err; }
      throw err;
    }

    return {
      restoredFrom: inspection.filePath,
      safetyCopy,
      productCount: inspection.productCount,
      saleCount:    inspection.saleCount,
      itemCount:    inspection.itemCount,
      lastSaleAt:   inspection.lastSaleAt
    };
  }

  return {
    filePath,
    listProducts,
    getProduct,
    addProduct,
    updateProduct,
    deleteProduct,
    getCategories,
    getLowStock,
    countLowStock,
    seedSampleProducts,
    // Phase 4
    createSale,
    getSale,
    getSaleByBillNumber,
    listSales,
    getSalesTodaySummary,
    seedDemoSales,
    getStoreSettings,
    getTaxPercent,
    setTaxPercent,
    // Phase 5
    validateStoreProfile,
    setStoreProfile,
    getReceiptProfile,
    getSalesSummary,
    getSalesDailyTrend,
    getBestSellers,
    getInventoryValuation,
    listRecentSales,
    // Backup / restore
    backupDatabase,
    inspectDatabase,
    restoreDatabase,
    close
  };
}

module.exports = {
  createDatabase,
  SAMPLE_PRODUCTS,
  SAMPLE_CATEGORIES,
  DEFAULT_STORE_PROFILE,
  STORE_PROFILE_FIELDS,
  formatLocalTimestamp
};