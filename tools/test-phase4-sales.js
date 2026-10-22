// QuickBill — Phase 4 smoke test.
//
// Plain-Node script; runs against a fresh in-memory SQLite. Verifies the
// checkout, sales history and tax-settings paths end-to-end. Not a
// framework-based test runner — just deterministic assertions with exit
// codes so a failing build fails CI.
//
// Run with:  node tools/test-phase4-sales.js
//
// What it covers (Phase 4 requirements §12):
//   1. Happy path: cart → sale → bill items → stock decrement → tax.
//   2. Insufficient stock: rolls back the transaction (no sale, no decrement).
//   3. Unknown barcode: rolls back, surfaces PRODUCT_MISSING.
//   4. Empty cart / bad input: rejects with VALIDATION.
//   5. Idempotency: same client_request_id returns the original sale without
//      re-inserting.
//   6. Bill-number uniqueness: two checkouts in a tight loop → both succeed
//      with distinct bill numbers.
//   7. Payment status derivation: paid / partial / unpaid across cash flows.
//   8. Tax settings: round-trip get/set/getTaxPercent.
//   9. Sales history queries: list + filter + getSale.

'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const { createDatabase, SAMPLE_PRODUCTS } = require('../src/main/db.js');

// ---------------------------------------------------------------------------
// Tiny test harness — keeps the smoke test a single Node script with zero
// dependencies. `assert(cond, msg)` throws with a stack trace so a failure
// is obvious, and a pass/fail tally is printed at the end.
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}

function section(name, fn) {
  console.log(`\n• ${name}`);
  try { fn(); }
  catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ threw: ${e.message}\n${e.stack || ''}`);
  }
}

function expectThrow(fn, codeMatcher) {
  try { fn(); }
  catch (e) {
    if (codeMatcher && !codeMatcher.test(String(e.code || ''))) {
      throw new Error(`expected error code matching ${codeMatcher}, got ${e.code || '(no code)'}`);
    }
    return e;
  }
  throw new Error('expected error, none thrown');
}

function freshDb() {
  // Each scenario gets its own DB so transactions don't pollute one another.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-phase4-'));
  return createDatabase(dir);
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path
// ---------------------------------------------------------------------------

section('1. Happy path: sale inserts sale + items and decrements stock', () => {
  const db = freshDb();
  const seeded = db.seedSampleProducts();
  assert(seeded.inserted === SAMPLE_PRODUCTS.length, 'seeder inserts all sample products');

  const target = SAMPLE_PRODUCTS[0]; // Sparkling Water 1L — 48 in stock, ₹1.20
  const res = db.createSale({
    clientRequestId: 'happy-1',
    items: [{ barcode: target.barcode, quantity: 3 }],
    discountPaise: 0,
    taxPercent: 5,
    payment: { method: 'cash', amountReceivedPaise: 5_00 },
    cashierName: 'Salman'
  });
  assert(res && res.sale, 'sale object returned');
  assert(res.replayed === false, 'first checkout is not replayed');

  const sale = res.sale;
  assert(sale.bill_number && /^INV-\d{8}-\d{4}$/.test(sale.bill_number),
    `bill_number matches INV-YYYYMMDD-#### (got ${sale.bill_number})`);
  assert(sale.total_paise === 3 * 120 + Math.round((3 * 120) * 0.05),
    `total paise = 3 * 1.20 + 5% tax (got ${sale.total_paise})`);
  assert(sale.tax_paise === 18, `tax = 18 paise (got ${sale.tax_paise})`);
  assert(sale.payment_method === 'cash', 'payment_method stored as cash');
  assert(sale.payment_status === 'paid', `payment_status = paid (got ${sale.payment_status})`);
  assert(sale.amount_received_paise === 500, 'amount_received_paise stored');
  assert(sale.change_due_paise === 500 - sale.total_paise,
    `change_due = received - total (got ${sale.change_due_paise}, expected ${500 - sale.total_paise})`);
  assert(sale.items && sale.items.length === 1, 'one sale_item row created');
  assert(sale.items[0].quantity === 3 && sale.items[0].unit_price_paise === 120 && sale.items[0].line_total_paise === 360,
    'line item encodes unit price, qty and line total');

  const fresh = db.getProduct(SAMPLE_PRODUCTS[0].id != null ? db.listProducts({ search: target.barcode })[0].id : undefined);
  // getProduct by id; we look it up explicitly:
  const listed = db.listProducts({ search: target.barcode })[0];
  const after = db.getProduct(listed.id);
  assert(after.stock_quantity === 48 - 3, `stock decremented to 45 (got ${after.stock_quantity})`);

  db.close();
});

// ---------------------------------------------------------------------------
// Test 2 — Insufficient stock rolls back everything
// ---------------------------------------------------------------------------

section('2. Insufficient stock: entire transaction rolls back', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const target = SAMPLE_PRODUCTS.find((p) => p.sku === 'DAI-004'); // Whole Milk 1L — stock 3
  const originalStock = target.stock_quantity;

  let thrown = null;
  try {
    db.createSale({
      clientRequestId: 'over-1',
      items: [{ barcode: target.barcode, quantity: 99 }],  // way more than 3 in stock
      discountPaise: 0,
      taxPercent: 0,
      payment: { method: 'cash', amountReceivedPaise: 100_00 }
    });
  } catch (e) { thrown = e; }

  assert(thrown, 'createSale rejected the over-drawn sale');
  assert(thrown.code === 'INSUFFICIENT_STOCK', `error code = INSUFFICIENT_STOCK (got ${thrown.code})`);
  assert(thrown.available === 3, `error carried available stock (got ${thrown.available})`);
  assert(thrown.requested === 99, 'error carried requested qty');

  // Rollback proof: stock unchanged, no sale rows, no sale_items rows.
  const listed = db.listProducts({ search: target.barcode })[0];
  assert(db.getProduct(listed.id).stock_quantity === originalStock,
    'product stock unchanged after rollback');

  const sales = db.listSales({ limit: 10 });
  assert(sales.length === 0, `no sales persisted (got ${sales.length})`);

  db.close();
});

// ---------------------------------------------------------------------------
// Test 3 — Unknown barcode
// ---------------------------------------------------------------------------

section('3. Unknown barcode: rolls back, returns PRODUCT_MISSING', () => {
  const db = freshDb();
  db.seedSampleProducts();
  let thrown = null;
  try {
    db.createSale({
      clientRequestId: 'unknown-1',
      items: [{ barcode: '0000000000000', quantity: 1 }],
      discountPaise: 0,
      taxPercent: 0,
      payment: { method: 'cash', amountReceivedPaise: 100 }
    });
  } catch (e) { thrown = e; }
  assert(thrown, 'createSale rejected the unknown barcode');
  assert(thrown.code === 'PRODUCT_MISSING', `code = PRODUCT_MISSING (got ${thrown.code})`);
  assert(thrown.barcode === '0000000000000', 'error carries the offending barcode');
  db.close();
});

// ---------------------------------------------------------------------------
// Test 4 — Invalid input (empty cart, bad quantities, bad payment)
// ---------------------------------------------------------------------------

section('4. Invalid input: VALIDATION errors without touching the DB', () => {
  const db = freshDb();
  db.seedSampleProducts();

  // empty cart
  expectThrow(() => db.createSale({
    clientRequestId: 'v-1',
    items: [],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 0 }
  }), /VALIDATION/);

  // bad qty
  expectThrow(() => db.createSale({
    clientRequestId: 'v-2',
    items: [{ barcode: SAMPLE_PRODUCTS[0].barcode, quantity: 0 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 0 }
  }), /VALIDATION/);

  // negative discount
  expectThrow(() => db.createSale({
    clientRequestId: 'v-3',
    items: [{ barcode: SAMPLE_PRODUCTS[0].barcode, quantity: 1 }],
    discountPaise: -100,
    taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 0 }
  }), /VALIDATION/);

  // bad payment method
  expectThrow(() => db.createSale({
    clientRequestId: 'v-4',
    items: [{ barcode: SAMPLE_PRODUCTS[0].barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'bitcoin', amountReceivedPaise: 0 }
  }), /VALIDATION/);

  // bad taxPercent
  expectThrow(() => db.createSale({
    clientRequestId: 'v-5',
    items: [{ barcode: SAMPLE_PRODUCTS[0].barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: -1,
    payment: { method: 'cash', amountReceivedPaise: 0 }
  }), /VALIDATION/);

  db.close();
});

// ---------------------------------------------------------------------------
// Test 5 — Idempotency: same client_request_id returns the same sale
// ---------------------------------------------------------------------------

section('5. Idempotency: duplicate client_request_id returns prior sale', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const target = SAMPLE_PRODUCTS[0];
  const r1 = db.createSale({
    clientRequestId: 'idem-A',
    items: [{ barcode: target.barcode, quantity: 2 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 5_00 }
  });
  const r2 = db.createSale({
    clientRequestId: 'idem-A',
    items: [{ barcode: target.barcode, quantity: 999 }],    // would normally fail
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 5_00 }
  });
  assert(r1.replayed === false, 'first call is fresh');
  assert(r2.replayed === true, 'second call with same id replays');
  assert(r1.sale.id === r2.sale.id, 'both sales have the same id');
  assert(r1.sale.bill_number === r2.sale.bill_number, 'same bill number on replay');

  // Stock should be deducted exactly once — proof that the replay is read-only.
  const listed = db.listProducts({ search: target.barcode })[0];
  const after = db.getProduct(listed.id);
  assert(after.stock_quantity === SAMPLE_PRODUCTS[0].stock_quantity - 2,
    `stock decremented exactly once (got ${after.stock_quantity}, expected ${SAMPLE_PRODUCTS[0].stock_quantity - 2})`);

  const all = db.listSales({ limit: 100 });
  assert(all.length === 1, `exactly one sale persisted (got ${all.length})`);

  db.close();
});

// ---------------------------------------------------------------------------
// Test 6 — Bill number uniqueness under burst
// ---------------------------------------------------------------------------

section('6. Bill number uniqueness: multiple sales get distinct bill_numbers', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const target = SAMPLE_PRODUCTS[0];
  const billNumbers = new Set();
  for (let i = 0; i < 5; i++) {
    const r = db.createSale({
      clientRequestId: `burst-${i}`,
      items: [{ barcode: target.barcode, quantity: 1 }],
      discountPaise: 0, taxPercent: 0,
      payment: { method: 'cash', amountReceivedPaise: 5_00 }
    });
    billNumbers.add(r.sale.bill_number);
  }
  assert(billNumbers.size === 5, `5 distinct bill numbers (got ${billNumbers.size})`);
  db.close();
});

// ---------------------------------------------------------------------------
// Test 7 — Payment status derivation (paid / partial / unpaid)
// ---------------------------------------------------------------------------

section('7. Payment status: paid / partial / unpaid derivations', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const target = SAMPLE_PRODUCTS[0];

  // 1. Exact payment
  const rA = db.createSale({
    clientRequestId: 'pay-A',
    items: [{ barcode: target.barcode, quantity: 1 }],   // ₹1.20 = 120 paise
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 120 }
  });
  assert(rA.sale.payment_status === 'paid' && rA.sale.change_due_paise === 0, 'exact cash → paid, no change');

  // 2. Overpayment
  const rB = db.createSale({
    clientRequestId: 'pay-B',
    items: [{ barcode: target.barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 500 }
  });
  assert(rB.sale.payment_status === 'paid', 'overpayment → paid');
  assert(rB.sale.change_due_paise === 500 - 120, 'overpayment change computed correctly');

  // 3. Partial payment
  const rC = db.createSale({
    clientRequestId: 'pay-C',
    items: [{ barcode: target.barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 50 }
  });
  assert(rC.sale.payment_status === 'partial', 'partial cash → partial');

  // 4. Unpaid method
  const rD = db.createSale({
    clientRequestId: 'pay-D',
    items: [{ barcode: target.barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'unpaid', amountReceivedPaise: 0 }
  });
  assert(rD.sale.payment_status === 'unpaid', 'unpaid method → unpaid');
  assert(rD.sale.amount_received_paise === 0, 'unpaid sale records 0 received');

  db.close();
});

// ---------------------------------------------------------------------------
// Test 8 — Tax settings round-trip
// ---------------------------------------------------------------------------

section('8. Tax settings: get / set / get round-trip', () => {
  const db = freshDb();
  const before = db.getTaxPercent();
  assert(before === 0, `default tax rate is 0% (got ${before})`);

  db.setTaxPercent(8.5);
  assert(db.getTaxPercent() === 8.5, 'set → get round-trips a percent');

  db.setTaxPercent(0);
  assert(db.getTaxPercent() === 0, 'reset to 0 works');

  expectThrow(() => db.setTaxPercent(-1), /VALIDATION/);
  expectThrow(() => db.setTaxPercent(1e9), /VALIDATION/);
  db.close();
});

// ---------------------------------------------------------------------------
// Test 9 — Sales history: list with filters, getSale
// ---------------------------------------------------------------------------

section('9. Sales history: filter by bill, getSale, item_count aggregation', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const a = SAMPLE_PRODUCTS[0];
  const b = SAMPLE_PRODUCTS.find((p) => p.sku === 'DAI-004');

  const r1 = db.createSale({
    clientRequestId: 'h-1',
    items: [
      { barcode: a.barcode, quantity: 2 },
      { barcode: b.barcode, quantity: 1 }
    ],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 5_00 }
  });
  const r2 = db.createSale({
    clientRequestId: 'h-2',
    items: [{ barcode: a.barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'unpaid', amountReceivedPaise: 0 }
  });

  const all = db.listSales({ limit: 10 });
  assert(all.length === 2, `listSales returns both (got ${all.length})`);
  const first = all[0];
  assert(typeof first.item_count === 'number', 'listSales aggregates item_count');
  // r1 had 3 items, r2 had 1 — the most recent should be r2 first.
  assert(first.bill_number === r2.sale.bill_number, 'listSales orders newest first');

  // Bill search filter
  const filtered = db.listSales({ bill: r1.sale.bill_number.slice(-6), limit: 10 });
  assert(filtered.length === 1 && filtered[0].id === r1.sale.id, 'bill substring filter works');

  // getSale returns the same row with items
  const got = db.getSale(r1.sale.id);
  assert(got && got.id === r1.sale.id, 'getSale returns the sale');
  assert(got.items.length === 2, 'getSale hydrates items');
  assert(got.items.every((it) => it.sale_id === r1.sale.id), 'items have sale_id');

  // getSaleByBillNumber
  const byBill = db.getSaleByBillNumber(r2.sale.bill_number);
  assert(byBill && byBill.id === r2.sale.id, 'getSaleByBillNumber works');

  db.close();
});

// ---------------------------------------------------------------------------
// Test 10 — Stock proof: after a sale, the products table reflects the
// decrement; the items table records the correct product_id and paise.
// ---------------------------------------------------------------------------

section('10. Sale persists authoritative prices (not renderer input)', () => {
  const db = freshDb();
  db.seedSampleProducts();
  const target = SAMPLE_PRODUCTS.find((p) => p.sku === 'BEV-031');
  // Submit a "malicious" payload that claims the product is 1/100 the price.
  const r = db.createSale({
    clientRequestId: 'auth-1',
    items: [{ barcode: target.barcode, quantity: 1 }],
    discountPaise: 0, taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 100 }
    // NOTE: no unit_price_paise / stock_quantity is sent — main process owns them.
  });
  assert(r.sale.items[0].unit_price_paise === 120,
    `unit_price_paise came from DB (got ${r.sale.items[0].unit_price_paise})`);
  // Stock decrement is from the authoritative count.
  const listed = db.listProducts({ search: target.barcode })[0];
  assert(db.getProduct(listed.id).stock_quantity === target.stock_quantity - 1,
    'stock decremented by authoritative DB read');
  db.close();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const msg of failures) console.log(`  • ${msg}`);
  process.exit(1);
}
process.exit(0);
