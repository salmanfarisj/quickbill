// QuickBill — demo month smoke test.
//
// Plain-Node script (run under ELECTRON_RUN_AS_NODE by tools/run-tests.js so
// the prebuilt better-sqlite3 binary matches the loaded Node ABI). Verifies
// that "Load demo month" produces a ledger that behaves like a real one:
//
//   1. Books `days` consecutive days of invoices, ending today.
//   2. Every invoice is a real sale: line items, tax, payment, change due.
//   3. Bill numbers are unique AND carry the date they were rung up on.
//   4. The reported totals match what the reports queries independently sum.
//   5. Stock never goes negative — the seeder tops up before selling.
//   6. Timestamps are spread through trading hours, never in the future.
//   7. Re-running inserts nothing (idempotent) and leaves the ledger alone.
//   8. A shorter/longer window only fills the days that are still missing.
//   9. An empty catalogue is refused rather than silently seeded.
//  10. The renderer cannot backdate a checkout through createSale's payload.
//  11. The demo path leaves no sale-edit API behind (append-only invariant).

'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const { createDatabase, SAMPLE_PRODUCTS } = require('../src/main/db.js');

// ---------------------------------------------------------------------------
// Tiny test harness — same shape as tools/test-phase4-sales.js.
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
  catch (err) {
    failed++;
    failures.push(`${name} threw: ${err?.message || err}`);
    console.log(`  ✗ threw: ${err?.message || err}\n${err?.stack || ''}`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-demo-'));
  const db = createDatabase(dir);
  db.seedSampleProducts();
  db.setStoreProfile({ storeName: 'Demo Mart', taxPercent: 5 });
  return db;
}

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// SQLite stores created_at as UTC; re-derive the LOCAL day the app groups by.
function localDayOf(row) {
  return localDay(new Date(`${String(row.created_at).replace(' ', 'T')}Z`));
}

const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDay(d);
};

// ---------------------------------------------------------------------------
// 1 — A month of history, day by day
// ---------------------------------------------------------------------------

section('1. Books N consecutive days of invoices ending today', () => {
  const db = freshDb();
  const res = db.seedDemoSales({ days: 30 });

  assert(res.inserted > 0, `inserted invoices (got ${res.inserted})`);
  assert(res.days === 30, `covered 30 days (got ${res.days})`);
  assert(res.to === dayOffset(0), `ends today (got ${res.to})`);
  assert(res.from === dayOffset(29), `starts 29 days back (got ${res.from})`);

  // Every COMPLETED day must carry invoices — a "month of history" with gaps
  // in it is not a month of history. Today is excluded: its plan scales with
  // the trading hours that have elapsed, so a run started before opening can
  // legitimately leave it at zero.
  const missing = [];
  for (let back = 29; back >= 1; back--) {
    const day = dayOffset(back);
    if (db.listSales({ from: day, to: day, limit: 1000 }).length === 0) missing.push(day);
  }
  assert(missing.length === 0, `every completed day has sales (empty: ${missing.join(', ') || 'none'})`);
  assert(res.days >= 29, `covers the full window (got ${res.days} days with new invoices)`);

  db.close();
});

// ---------------------------------------------------------------------------
// 2 — The invoices are real sales
// ---------------------------------------------------------------------------

section('2. Every invoice carries items, totals, tax and payment', () => {
  const db = freshDb();
  db.seedDemoSales({ days: 7 });
  const rows = db.listSales({ limit: 1000 });

  assert(rows.length > 0, 'sales exist');
  assert(rows.every((r) => Number(r.item_count) >= 1), 'every sale has at least one line item');
  assert(rows.every((r) => Number(r.total_paise) > 0), 'every sale has a positive total');
  assert(rows.every((r) => Number(r.tax_paise) >= 0), 'tax is recorded');

  // The seeder applies the store's configured 5% — a mismatch here means
  // demo receipts would disagree with the live tax setting.
  const taxed = rows.filter((r) => Number(r.tax_paise) > 0);
  assert(taxed.length > 0, 'some invoices carry tax');
  assert(
    taxed.every((r) => Math.abs(Number(r.tax_percent) - 5) < 0.001),
    'tax percent matches the configured store rate'
  );

  // Payment mix: the Reports screen buckets on these, so the demo must
  // populate more than one — otherwise "unpaid/partial" cards are always 0.
  const statuses = new Set(rows.map((r) => r.payment_status));
  assert(statuses.size >= 2, `demo exercises multiple payment statuses (got ${[...statuses].join(',')})`);

  // Change due must reconcile: paid cash with an over-tender owes change.
  const withChange = rows.filter((r) => Number(r.change_due_paise) > 0);
  assert(withChange.length > 0, 'some invoices have change due');
  assert(
    withChange.every((r) => r.payment_status === 'paid'),
    'change is only ever recorded on a fully-paid sale'
  );
  assert(
    rows.every((r) => Number(r.change_due_paise) === 0 || r.payment_method === 'cash'),
    'credit sales never carry change'
  );

  db.close();
});

// ---------------------------------------------------------------------------
// 3 — Bill numbers are unique and date-stamped to their own day
// ---------------------------------------------------------------------------

section('3. Bill numbers are unique and carry their own booking date', () => {
  const db = freshDb();
  db.seedDemoSales({ days: 14 });
  const rows = db.listSales({ limit: 1000 });

  const bills = rows.map((r) => r.bill_number);
  assert(new Set(bills).size === bills.length, 'every bill number is unique');

  // A backdated invoice MUST NOT carry today's date prefix — that is the
  // defect that made the old hand-rolled seeder produce INV-20261021-####
  // on a sale dated a month ago.
  const mismatched = rows.filter((r) => {
    const m = /^INV-(\d{4})(\d{2})(\d{2})-\d{4}$/.exec(r.bill_number || '');
    if (!m) return true;
    const billDay = `${m[1]}-${m[2]}-${m[3]}`;
    return billDay !== localDayOf(r);
  });
  assert(
    mismatched.length === 0,
    `bill-number date matches created_at day (bad: ${mismatched.slice(0, 3).map((r) => r.bill_number).join(', ') || 'none'})`
  );

  // Two invoices on the same day must get different serials.
  const byDay = new Map();
  for (const r of rows) {
    const day = localDayOf(r);
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(r.bill_number);
  }
  assert(byDay.size >= 7, `history spans many days (got ${byDay.size})`);

  db.close();
});

// ---------------------------------------------------------------------------
// 4 — Reports read the seeded month correctly
// ---------------------------------------------------------------------------

section('4. Dashboard/report queries aggregate the seeded month', () => {
  const db = freshDb();
  const res = db.seedDemoSales({ days: 30 });
  const rows = db.listSales({ limit: 1000 });

  const summary = db.getSalesSummary({});
  assert(summary.saleCount === rows.length, 'summary counts every seeded sale');
  assert(summary.totalPaise === res.totalPaise, 'summary total matches what the seeder reported');

  // paid + partial + unpaid must reconcile to the headline total, or the
  // Reports payment-split cards would not add up to the invoice list.
  assert(
    summary.paidPaise + summary.partialPaise + summary.unpaidPaise === summary.totalPaise,
    'payment buckets sum to the total'
  );
  assert(summary.avgTicketPaise > 0, 'average ticket is positive');

  const trend = db.getSalesDailyTrend({ limit: 30 });
  assert(trend.length === 30, `daily trend has one point per day (got ${trend.length})`);
  assert(
    trend.every((t) => t.saleCount > 0 && t.totalPaise > 0),
    'every trend day has sales and revenue'
  );
  assert(trend.reduce((s, t) => s + t.totalPaise, 0) === summary.totalPaise,
    'trend revenue reconciles with the summary total');

  const best = db.getBestSellers({ limit: 5 });
  assert(best.length === 5, 'best sellers returns a ranked list');
  assert(best.every((b) => b.quantitySold > 0), 'best sellers have real quantities');
  // Ranked by quantity sold, descending.
  for (let i = 1; i < best.length; i++) {
    assert(best[i - 1].quantitySold >= best[i].quantitySold, 'best sellers are ordered by quantity');
  }

  db.close();
});

// ---------------------------------------------------------------------------
// 5 — Stock: topped up first, never negative
// ---------------------------------------------------------------------------

section('5. Stock is topped up before selling and never goes negative', () => {
  const db = freshDb();
  const res = db.seedDemoSales({ days: 30 });

  assert(res.restocked > 0, `the seeder reports the stock it raised (got ${res.restocked})`);

  const rows = db.listProducts({});
  const negative = rows.filter((p) => Number(p.stock_quantity) < 0);
  assert(negative.length === 0, 'no product ended up with negative stock');

  // After a month of trading the shop should NOT be sitting on its reorder
  // levels — that would light up the whole inventory as low stock and pin
  // the sidebar badge at "everything needs reordering".
  const onReorder = rows.filter((p) => Number(p.stock_quantity) === Number(p.min_stock_level));
  assert(onReorder.length < rows.length,
    `most products finish above their reorder level (${onReorder.length}/${rows.length} pinned)`);
  assert(
    rows.every((p) => Number(p.stock_quantity) >= Number(p.min_stock_level)),
    'every product is still at or above its reorder level'
  );

  db.close();
});

// ---------------------------------------------------------------------------
// 6 — Timestamps
// ---------------------------------------------------------------------------

section('6. Invoices carry spread-out, plausible timestamps', () => {
  const db = freshDb();
  db.seedDemoSales({ days: 7 });
  const rows = db.listSales({ limit: 1000 });

  // Nothing may be stamped in the future.
  const now = Date.now();
  const future = rows.filter(
    (r) => new Date(`${String(r.created_at).replace(' ', 'T')}Z`).getTime() > now
  );
  assert(future.length === 0, `no invoice is dated in the future (${future.length} found)`);

  // Every day must have MORE THAN ONE distinct time. Clamping the whole of
  // today to "now" produces a day where all its invoices share one
  // timestamp — invisible in totals but obviously fake in the list.
  // created_at is stored in UTC, so both the "distinct time" and the
  // trading-hours checks below must convert to local before slicing the
  // clock — otherwise every assertion is off by the machine's UTC offset.
  const localTimeOf = (row) => {
    const d = new Date(`${String(row.created_at).replace(' ', 'T')}Z`);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const byDay = new Map();
  for (const r of rows) {
    const day = localDayOf(r);
    if (!byDay.has(day)) byDay.set(day, { times: new Set(), n: 0 });
    byDay.get(day).times.add(localTimeOf(r));
    byDay.get(day).n++;
  }
  // A day with a single invoice obviously has one time; the invariant is
  // that COLLAPSING didn't happen, so only judge days that hold 2+ invoices.
  // (Today can legitimately hold just one when the seeder runs before the
  // shop's trading day has properly started.)
  const flat = [...byDay.entries()]
    .filter(([, v]) => v.n >= 2 && v.times.size < 2)
    .map(([d]) => d);
  assert(flat.length === 0,
    `no day collapses its invoices onto one timestamp (flat: ${flat.join(', ') || 'none'})`);

  // Past invoices fall inside trading hours (08:00–21:00 local).
  const outOfHours = rows.filter((r) => {
    if (localDayOf(r) === dayOffset(0)) return false;     // today is compressed
    const mins = Number(localTimeOf(r).slice(0, 2)) * 60 + Number(localTimeOf(r).slice(3, 5));
    return mins < 8 * 60 || mins > 21 * 60;
  });
  assert(outOfHours.length === 0, `past invoices fall in trading hours (${outOfHours.length} outside)`);

  db.close();
});

// ---------------------------------------------------------------------------
// 7 — Idempotency
// ---------------------------------------------------------------------------

section('7. Re-running the seeder changes nothing', () => {
  const db = freshDb();
  const first = db.seedDemoSales({ days: 30 });
  const rowsAfterFirst = db.listSales({ limit: 1000 }).length;
  const stockAfterFirst = db.listProducts({}).map((p) => p.stock_quantity);
  const totalAfterFirst = db.getSalesSummary({}).totalPaise;

  const second = db.seedDemoSales({ days: 30 });
  assert(second.inserted === 0, `second run inserts nothing (got ${second.inserted})`);
  assert(second.days === 0, `second run has no days left to fill (got ${second.days})`);

  assert(
    db.listSales({ limit: 1000 }).length === rowsAfterFirst,
    'sale count unchanged after re-running'
  );
  const stockNow = db.listProducts({}).map((p) => p.stock_quantity);
  assert(
    JSON.stringify(stockNow) === JSON.stringify(stockAfterFirst),
    'stock unchanged after re-running'
  );
  // Must compare against the value captured BEFORE the second run — an
  // earlier version of this line compared getSalesSummary to itself, which is
  // always true and so could never catch a re-booked day.
  assert(db.getSalesSummary({}).totalPaise === totalAfterFirst,
    `total revenue unchanged after re-running (got ${db.getSalesSummary({}).totalPaise}, want ${totalAfterFirst})`);

  db.close();
});

// ---------------------------------------------------------------------------
// 8 — Partial windows fill only the gap
// ---------------------------------------------------------------------------

section('8. Asking for more days only fills what is missing', () => {
  const db = freshDb();
  const first = db.seedDemoSales({ days: 7 });
  assert(first.days >= 6, `first run covered ~7 days (got ${first.days})`);

  // A longer request must extend backwards, never re-book the days that
  // already exist (the idempotency keys would replay them otherwise).
  const second = db.seedDemoSales({ days: 30 });
  assert(second.days >= 23, `only the missing days are booked (got ${second.days})`);
  assert(second.inserted > 0, 'the extension inserts the missing days');
  assert(second.from === dayOffset(29), `extension reaches back 30 days (got ${second.from})`);

  const summary = db.getSalesSummary({});
  assert(summary.saleCount > 0, 'the extended ledger still aggregates');

  db.close();
});

// ---------------------------------------------------------------------------
// 9 — Guards
// ---------------------------------------------------------------------------

section('9. Bad input and empty catalogues are refused', () => {
  const empty = createDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-demo-empty-')));
  const e = expectThrow(() => empty.seedDemoSales({ days: 30 }), /NO_PRODUCTS/);
  assert(/sample products/i.test(e.message), 'empty-catalogue error tells the operator what to do');
  assert(empty.listProducts({}).length === 0, 'refusing did not silently seed products');
  empty.close();

  const db = freshDb();
  for (const bad of [0, -5, 91, 1.5, 'abc', Infinity]) {
    expectThrow(() => db.seedDemoSales({ days: bad }), /VALIDATION/);
  }
  assert(true, 'out-of-range day counts are rejected with VALIDATION');

  // null/undefined mean "use the default" — the IPC handler forwards an
  // empty payload straight through, so this is the normal path.
  assert(db.seedDemoSales({ days: null }).days === 30, 'null falls back to the 30-day default');
  assert(db.seedDemoSales({}).days === 0, 'an omitted day count uses the default (already filled)');
  db.close();
});

// ---------------------------------------------------------------------------
// 10 — The renderer cannot forge history
// ---------------------------------------------------------------------------

section('10. A checkout through the public payload cannot be backdated', () => {
  const db = freshDb();
  const target = SAMPLE_PRODUCTS[0];
  const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);

  // Exactly the payload an IPC caller controls. `createdAt` here is inert:
  // createSale only honours the SECOND (main-process) argument.
  const r = db.createSale({
    items: [{ barcode: target.barcode, quantity: 1 }],
    discountPaise: 0,
    taxPercent: 0,
    payment: { method: 'cash', amountReceivedPaise: 10000 },
    cashierName: 'Probe',
    clientRequestId: 'no-backdate',
    createdAt: past
  });

  const stored = db.getSale(r.sale.id);
  assert(localDayOf(stored) === dayOffset(0), 'the sale landed today, not 40 days ago');
  assert(
    stored.bill_number.startsWith(`INV-${dayOffset(0).replace(/-/g, '')}`),
    `bill number is today's (got ${stored.bill_number})`
  );

  // And the demo seeder itself still works on the same DB afterwards.
  const seeded = db.seedDemoSales({ days: 5 });
  assert(seeded.inserted > 0, 'seeding still works after a normal checkout');

  // An INHERITED createdAt must be ignored too. createSale's timestamp
  // override is the trust boundary that stops backdating; a Date on the
  // prototype chain is not something the caller supplied.
  const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const inherited = db.createSale(
    {
      items: [{ barcode: SAMPLE_PRODUCTS[1].barcode, quantity: 1 }],
      discountPaise: 0, taxPercent: 0,
      payment: { method: 'cash', amountReceivedPaise: 10000 },
      clientRequestId: 'inherited-created-at'
    },
    Object.create({ createdAt: longAgo })
  );
  const inheritedRow = db.getSale(inherited.sale.id);
  assert(localDayOf(inheritedRow) === dayOffset(0),
    `a prototype-inherited createdAt is ignored (landed ${localDayOf(inheritedRow)})`);

  // A present-but-invalid own value must fall back to the wall clock too.
  const bogus = db.createSale(
    {
      items: [{ barcode: SAMPLE_PRODUCTS[2].barcode, quantity: 1 }],
      discountPaise: 0, taxPercent: 0,
      payment: { method: 'cash', amountReceivedPaise: 10000 },
      clientRequestId: 'invalid-created-at'
    },
    { createdAt: 'not-a-date' }
  );
  assert(localDayOf(db.getSale(bogus.sale.id)) === dayOffset(0),
    'a non-Date createdAt falls back to now');

  db.close();
});

// ---------------------------------------------------------------------------
// 11 — Free products must not swamp baskets
// ---------------------------------------------------------------------------

section('11. A free-priced product does not produce zero-total invoices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-demo-free-'));
  const db = createDatabase(dir);
  db.setStoreProfile({ storeName: 'Free Shop', taxPercent: 5 });
  // selling_price 0 with cost_price 0 is legal per validateProductInput.
  db.addProduct({ barcode: 'FREE-0001', sku: 'FRE-001', name: 'Free Sample',
    category: 'General', cost_price: 0, selling_price: 0,
    stock_quantity: 500, min_stock_level: 10 });
  db.addProduct({ barcode: 'PAID-0001', sku: 'PAI-001', name: 'Paid Item',
    category: 'General', cost_price: 4, selling_price: 5,
    stock_quantity: 500, min_stock_level: 10 });

  db.seedDemoSales({ days: 7 });
  const rows = db.listSales({ limit: 1000 });
  assert(rows.length > 0, 'seeding produced sales for the mixed catalogue');

  const zeroTotal = rows.filter((r) => Number(r.total_paise) === 0);
  // A basket of nothing but free samples legitimately totals 0 — but it must
  // stay rare, not become the norm the way an inverted weight curve caused.
  assert(zeroTotal.length <= rows.length * 0.2,
    `free-only baskets stay rare (${zeroTotal.length}/${rows.length} zero-total)`);
  const paid = rows.filter((r) => Number(r.total_paise) > 0);
  assert(paid.length > rows.length * 0.8,
    `most baskets actually sell something (${paid.length}/${rows.length})`);
  db.close();
});

// ---------------------------------------------------------------------------
// 12 — Append-only invariant preserved
// ---------------------------------------------------------------------------

section('12. Demo history introduces no sale-edit surface', () => {
  const db = freshDb();
  db.seedDemoSales({ days: 5 });
  const fns = Object.keys(db).filter((k) => typeof db[k] === 'function');
  assert(
    !fns.some((k) => /update.*sale|edit.*sale|delete.*sale/i.test(k)),
    'no sale update/delete API is exposed'
  );
  // A seeded product is still protected from deletion by the FK.
  const sold = db.listProducts({})[0];
  const err = (() => {
    try { db.deleteProduct(sold.id); return null; } catch (e) { return e; }
  })();
  assert(err !== null, 'a product that appears on a demo invoice cannot be deleted');
  assert(err && err.code === 'PRODUCT_IN_USE', `deletion reports PRODUCT_IN_USE (got ${err?.code})`);
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