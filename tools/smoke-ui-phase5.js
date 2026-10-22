// QuickBill — Phase 5 headless UI smoke.
//
// Boots Electron headless, mounts every view through the real SPA
// controller, drives the interactive paths a user actually clicks
// (open a bill -> preview -> reprint), and asserts on what the DOM
// shows. Screenshots land in `tools/.smoke-phase5/` as visual evidence.
//
// Two properties this file deliberately has, because the previous
// version had neither:
//
//   1. It EXITS NON-ZERO when an assertion fails. The old harness
//      tracked `failures` and then called `app.quit()` unconditionally,
//      so a run that printed "printBtn=false" still reported success.
//   2. It uses the SAME IPC handlers the shipping app registers
//      (`createIpcHandlers` from src/main/ipc.js). The old harness kept
//      a hand-copied subset that stubbed `receipt:print` to always
//      succeed, so printing was never actually exercised.
//
// Print verification: the OS printer list is probed for real. When no
// printer is configured the harness asserts the NO_PRINTER contract
// (clear, actionable error surfaced to the user) — that IS the correct
// behaviour for a machine with no printers, and it's what we want to
// prove. When printers do exist, the real `webContents.print()` path
// runs with a temporary PDF output so the test never spams paper.
//
// Run with:
//   ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     tools/smoke-ui-phase5.js --no-sandbox --headless
//
// Exits 0 on success, 1 on any failed assertion.

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(REPO_ROOT, 'tools', '.smoke-phase5');

// Imported once at module scope so the assertions in `run()` (which lives
// outside bootDatabase()) can reach `formatLocalTimestamp` without a second
// require call.
const { formatLocalTimestamp } = require(path.join(REPO_ROOT, 'src', 'main', 'db.js'));

let db = null;
let win = null;
let failures = 0;
let checks = 0;
const results = [];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function check(name, cond, detail = '') {
  checks++;
  if (cond) {
    results.push({ name, pass: true, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    results.push({ name, pass: false, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return !!cond;
}

// ---------------------------------------------------------------------------
// Fixture data — one sale per day for the last N days, so date filtering and
// range-scoped reports have something real to separate.
// ---------------------------------------------------------------------------

async function bootDatabase() {
  const { createDatabase, SAMPLE_PRODUCTS } = require(path.join(REPO_ROOT, 'src', 'main', 'db.js'));
  // Fresh fixture DB on every run so results never depend on leftovers.
  fs.rmSync(path.join(OUT_DIR, 'userData'), { recursive: true, force: true });
  db = createDatabase(path.join(OUT_DIR, 'userData'));
  db.seedSampleProducts();

  const barcodeOf = (name) => {
    const sp = SAMPLE_PRODUCTS.find((p) => p.name === name);
    return sp ? sp.barcode : null;
  };

  db.setStoreProfile({
    storeName: 'QuickBill Smoke', storeAddress: '42 Smoke Lane', storePhone: '+1 555 0100',
    currencyCode: 'INR', currencySymbol: '₹', locale: 'en-IN', taxLabel: 'GST',
    invoicePrefix: 'INV', receiptFooter: 'Thanks!', taxPercent: 5
  });

  // Backdate rows so the range filters have distinct buckets. Written with an
  // explicit UTC stamp, exactly as SQLite's datetime('now') would have.
  const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
  const raw = new Database(db.filePath);
  const stamp = db.createSale({
    items: [{ barcode: barcodeOf('Sparkling Water 1L'), quantity: 2 }],
    payment: { method: 'cash', amountReceivedPaise: 5000 },
    cashierName: 'Smoke Test', clientRequestId: 'smoke-today-1'
  });
  for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const utc = d.toISOString().slice(0, 19).replace('T', ' ');
    const r = db.createSale({
      items: [{ barcode: barcodeOf('Orange Juice 1L'), quantity: daysAgo }],
      payment: { method: 'cash', amountReceivedPaise: 10000 },
      cashierName: 'Smoke Test', clientRequestId: `smoke-back-${daysAgo}`
    });
    raw.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(utc, r.sale.id);
  }
  raw.close();
  return { todaySaleId: stamp.sale.id };
}

// Bind the SHIPPING handlers to ipcMain, with the real printer backends.
function registerSmokeIpc(winRef) {
  const { createIpcHandlers } = require(path.join(REPO_ROOT, 'src', 'main', 'ipc.js'));

  const listPrinters = async () => {
    try { return await winRef.getPrintersAsync(); }
    catch (_e) { return []; }
  };

  // Mirrors main.js printHtmlDocument, but writes to a PDF file when the
  // harness asks for it, so a machine WITH a printer still doesn't print
  // 80mm receipts onto the developer's desk mid-test-run.
  const printDocument = ({ html, printer, copies, toPdf }) => new Promise((resolve) => {
    const pw = new BrowserWindow({
      show: false, width: 420, height: 720,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const done = (r) => { if (!pw.isDestroyed()) pw.close(); resolve(r); };
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    pw.webContents.on('did-finish-load', () => {
      if (toPdf) {
        // Electron's API is `printToPDF` (returns a Buffer) — there is no
        // `printToFile`. Calling the missing name threw a TypeError INSIDE
        // this event handler, which neither settled the promise nor
        // propagated to the caller, so the smoke hung forever instead of
        // reporting a failure. The try/catch keeps that class of mistake
        // observable rather than fatal.
        try {
          Promise.resolve(pw.webContents.printToPDF({ silent: true, printBackground: true }))
            .then((data) => done({ ok: true, pdfBytes: data.length }))
            .catch((err) => done({ ok: false, code: 'PRINTER_FAILED', message: String(err.message || err) }));
        } catch (err) {
          done({ ok: false, code: 'PRINTER_FAILED', message: String(err.message || err) });
        }
        return;
      }
      const opts = { silent: true, printBackground: true, pageSize: { width: 80000, height: 200000 } };
      if (printer) opts.deviceName = printer;
      if (copies) opts.copies = copies;
      pw.webContents.print(opts, (success, reason) => {
        if (success) return done({ ok: true });
        if (/cancelled/i.test(String(reason))) return done({ ok: false, code: 'PRINTER_CANCELLED', message: 'Printing was cancelled.' });
        return done({ ok: false, code: 'PRINTER_FAILED', message: `The system printer reported an error: ${reason}.` });
      });
    });
    pw.webContents.on('did-fail-load', (_e, c, desc) =>
      done({ ok: false, code: 'PRINTER_FAILED', message: `Could not render the receipt page: ${desc || c}.` }));
    pw.loadURL(url).catch((err) => done({ ok: false, code: 'PRINTER_FAILED', message: String(err?.message || err) }));
  });

  const handlers = createIpcHandlers({ db, listPrinters, printDocument });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_evt, payload) => handler(payload));
  }
  return { listPrinters, printDocument };
}

async function shot(name) {
  const snap = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), snap.toPNG());
}

const js = (code) => win.webContents.executeJavaScript(code, true);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

async function run(fixture) {
  ensureDir(OUT_DIR);
  fixture = await bootDatabase();
  const printersApi = registerSmokeIpc(win);
  win.loadFile(path.join(REPO_ROOT, 'src', 'index.html'));
  await new Promise((r) => win.webContents.once('did-finish-load', r));

  // ---- 1. Every view mounts --------------------------------------------
  console.log('\n[1] View mounting');
  for (const view of ['dashboard', 'reports', 'settings', 'sales-history', 'billing', 'inventory', 'products']) {
    const stats = await js(`(async () => {
      window.__quickbill.showView('${view}');
      await new Promise(r => setTimeout(r, 900));
      return {
        mounted: !!document.querySelector('.view'),
        cards: document.querySelectorAll('.card').length,
        loadingLeft: !!document.querySelector('.banner--loading'),
        errorShown: !!document.querySelector('.banner--error')
      };
    })()`);
    check(`view "${view}" mounts`, stats.mounted && stats.cards > 0, `cards=${stats.cards}`);
    check(`view "${view}" resolves loading`, !stats.loadingLeft, stats.loadingLeft ? 'still showing "Loading…"' : '');
    check(`view "${view}" has no error banner`, !stats.errorShown, stats.errorShown ? 'error banner present' : '');
    await shot(view);
  }

  // ---- 2. Dashboard numbers come from the DB ----------------------------
  console.log('\n[2] Dashboard totals match database records');
  const dash = await js(`(async () => {
    window.__quickbill.showView('dashboard');
    await new Promise(r => setTimeout(r, 1200));
    const r = await window.quickbill.reports.dashboard({
      from: document.querySelector('[data-role="from"]').value,
      to:   document.querySelector('[data-role="to"]').value
    });
    return { ok: r.ok, data: r.data };
  })()`);
  check('reports:dashboard responds ok', dash.ok);
  const dbToday = db.getSalesTodaySummary();
  check('dashboard "today" is today, not all-time',
    dash.data.today.saleCount === dbToday.saleCount,
    `dashboard=${dash.data.today.saleCount} db=${dbToday.saleCount}`);
  check('dashboard today total matches DB',
    dash.data.today.totalPaise === dbToday.totalPaise,
    `${dash.data.today.totalPaise} vs ${dbToday.totalPaise} paise`);
  const allTime = db.getSalesSummary({});
  check('all-time total is strictly larger than today (proves they differ)',
    allTime.saleCount > dbToday.saleCount,
    `all-time=${allTime.saleCount} today=${dbToday.saleCount}`);

  // ---- 3. Date filtering actually filters ------------------------------
  console.log('\n[3] Date filtering');
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
  const rangeDash = await js(`(async () => {
    const r = await window.quickbill.reports.dashboard({ from: '${yesterday}', to: '${yesterday}' });
    return { ok: r.ok, recent: r.data.recent.length, summary: r.data.summary.saleCount };
  })()`);
  const yesterdaySales = db.listSales({ from: yesterday, to: yesterday });
  check('dashboard "recent in range" excludes out-of-range sales',
    rangeDash.recent === yesterdaySales.length,
    `ui=${rangeDash.recent} db=${yesterdaySales.length}`);
  check('dashboard summary respects range',
    rangeDash.summary === yesterdaySales.length,
    `ui=${rangeDash.summary} db=${yesterdaySales.length}`);

  const histFilter = await js(`(async () => {
    window.__quickbill.showView('sales-history');
    await new Promise(r => setTimeout(r, 1000));
    const from = document.querySelector('[data-role="from"]');
    const to   = document.querySelector('[data-role="to"]');
    from.value = '${yesterday}'; to.value = '${yesterday}';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    return { rows: document.querySelectorAll('[data-action="view"]').length };
  })()`);
  check('Sales History date filter narrows the list',
    histFilter.rows === yesterdaySales.length,
    `ui=${histFilter.rows} db=${yesterdaySales.length}`);
  await shot('sales-history-filtered');

  // ---- 4. Reopen a completed receipt from history -----------------------
  console.log('\n[4] Receipt reopen + print action');
  const bill = await js(`(async () => {
    window.__quickbill.showView('sales-history');
    await new Promise(r => setTimeout(r, 1000));
    const from = document.querySelector('[data-role="from"]');
    const to   = document.querySelector('[data-role="to"]');
    from.value=''; to.value='';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const row = document.querySelector('[data-action="view"]');
    if (!row) return { rowFound: false };
    row.click();
    await new Promise(r => setTimeout(r, 1200));
    const modal = document.querySelector('[data-role="bill-modal"]');
    const txt = modal?.querySelector('[data-role="bill-body"]')?.innerText || '';
    return {
      rowFound: true,
      visible: !!modal && !modal.hidden,
      printBtn: !!document.querySelector('[data-action="bill-print"]'),
      printerSelect: !!document.querySelector('[data-role="printer-select"]'),
      receiptHtml: txt,
      billNo: (txt.match(/INV-[0-9-]+/) || [''])[0]
    };
  })()`);
  check('sales row opens the bill modal', bill.visible === true);
  check('modal exposes an explicit Print Receipt action', bill.printBtn === true);
  check('modal exposes a printer selector', bill.printerSelect === true);
  const expectSale = db.getSale(fixture.todaySaleId);
  check('receipt shows the persisted bill number',
    bill.billNo === expectSale.bill_number, `ui=${bill.billNo} db=${expectSale.bill_number}`);
  check('receipt shows the persisted total',
    bill.receiptHtml.includes((expectSale.total_paise / 100).toFixed(2)),
    `total_paise=${expectSale.total_paise}`);
  check('receipt shows change due', /Change due/i.test(bill.receiptHtml));
  check('receipt shows payment method', /Cash|Credit/i.test(bill.receiptHtml));
  // Assert the receipt shows the *sale's* local time, not the live clock
  // at assertion time and not the raw UTC stored in the database.
  // Using `new Date()` here is flaky — if the sale was created in the
  // previous minute the receipt text disagrees with the wall clock by
  // 60s even though both are "correct local". Compare against the same
  // formatter the receipt uses, applied to the sale's own created_at.
  const expectedLocal = formatLocalTimestamp(expectSale.created_at);
  const rawUtcLooksUnformatted = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(bill.receiptHtml);
  check('receipt shows a local (not UTC) timestamp',
    expectedLocal && bill.receiptHtml.includes(expectedLocal) && !rawUtcLooksUnformatted,
    `expected local=${JSON.stringify(expectedLocal)} utc=${expectSale.created_at}`);
  await shot('sales-history-bill-modal');

  // ---- 5. Frozen currency (requirement 8) ------------------------------
  console.log('\n[5] Historical integrity — currency frozen at checkout');
  db.setStoreProfile({ currencyCode: 'USD', currencySymbol: '$', locale: 'en-US' });
  const afterSwitch = await js(`(async () => {
    window.__quickbill.showView('sales-history');
    await new Promise(r => setTimeout(r, 1000));
    const row = document.querySelector('[data-action="view"]');
    row.click();
    await new Promise(r => setTimeout(r, 1200));
    return { txt: document.querySelector('[data-role="bill-body"]')?.innerText || '' };
  })()`);
  check('completed sale still prints in its original currency after a profile change',
    !afterSwitch.txt.includes('$'), 'no dollar symbol on an INR sale');
  db.setStoreProfile({ currencyCode: 'INR', currencySymbol: '₹', locale: 'en-IN' });

  // ---- 6. Print pipeline (real handlers) --------------------------------
  console.log('\n[6] Print pipeline');
  const printers = await printersApi.listPrinters();
  console.log(`     macOS reports ${printers.length} printer(s): ${printers.map(p => p.name).join(', ') || '(none)'}`);

  // Regardless of printer availability, the printable document must render.
  const printable = await js(`(async () => {
    const r = await window.quickbill.receipt.forSale(${fixture.todaySaleId});
    if (!r.ok) return { ok: false };
    return { ok: true, store: r.data.store, sale: r.data.sale };
  })()`);
  check('receipt:forSale returns a printable profile', printable.ok === true);

  // Build the print document through the SAME module the app uses, so the
  // bytes we hand to the print backend are the bytes a customer would get.
  const printableHtml = await js(`(async () => {
    const r = await window.quickbill.receipt.forSale(${fixture.todaySaleId});
    const mod = await import('./scripts/lib/receipt.js');
    return mod.buildPrintableReceiptHtml(r.data);
  })()`);
  check('printable receipt HTML is generated', typeof printableHtml === 'string' && printableHtml.length > 400,
    `${String(printableHtml).length} chars`);
  for (const needle of ['<!doctype html>', 'QuickBill Smoke', expectSale.bill_number, 'Change due']) {
    check(`printable HTML contains "${needle.slice(0, 28)}"`, String(printableHtml).includes(needle));
  }
  check('printable receipt HTML is generated', typeof printableHtml === 'string' && printableHtml.length > 400,
    `${String(printableHtml).length} chars`);

  // Drive the real print backend directly — the same function main.js hands
  // to `receipt:print` — rendering to a PDF so a machine that HAS a printer
  // doesn't spew 80mm receipts onto the desk mid-run.
  const pdfResult = await printersApi.printDocument({ html: printableHtml, toPdf: true });
  check('real Electron print pipeline renders the receipt',
    !!(pdfResult && pdfResult.ok && pdfResult.pdfBytes > 500),
    pdfResult && pdfResult.ok ? `${pdfResult.pdfBytes} bytes of PDF` : JSON.stringify(pdfResult));

  // Print through the user-facing handler and assert the error contract.
  const printViaApi = await js(`(async () => {
    const r = await window.quickbill.receipt.print({ html: ${JSON.stringify(printableHtml)}, copies: 1 });
    return r;
  })()`);
  if (printers.length === 0) {
    check('no-printer case returns the actionable NO_PRINTER error',
      printViaApi.ok === false && printViaApi.error.code === 'NO_PRINTER',
      JSON.stringify(printViaApi.error || printViaApi));
    check('NO_PRINTER message points at System Settings',
      /Printers & Scanners/.test(printViaApi.error?.message || ''),
      printViaApi.error?.message || '');
  } else {
    check('print request with printers present does not return NO_PRINTER',
      printViaApi.error?.code !== 'NO_PRINTER', JSON.stringify(printViaApi.error || 'ok'));
  }

  const badPrint = await js(`(async () => window.quickbill.receipt.print({}))()`);
  check('print request without HTML is rejected as VALIDATION',
    badPrint.ok === false && badPrint.error.code === 'VALIDATION');

  // ---- 7. Settings validation + persistence ----------------------------
  console.log('\n[7] Settings validation and persistence');
  const badSettings = await js(`(async () => window.quickbill.settings.setStoreProfile({ currencyCode: 'US DOLLARS' }))()`);
  check('invalid currency code is rejected with a field error',
    badSettings.ok === false && !!badSettings.error.errors?.currencyCode,
    JSON.stringify(badSettings.error?.errors || badSettings.error));
  const goodSettings = await js(`(async () => window.quickbill.settings.setStoreProfile({
    storeName: 'QuickBill Smoke', currencyCode: 'INR', currencySymbol: '₹',
    locale: 'en-IN', taxLabel: 'GST', invoicePrefix: 'INV', taxPercent: 5
  }))()`);
  check('valid settings persist', goodSettings.ok === true && goodSettings.data.storeName === 'QuickBill Smoke');
  check('settings round-trip tax rate', Number(goodSettings.data.taxPercent) === 5, `got ${goodSettings.data.taxPercent}`);

  // ---- 8. Empty state ---------------------------------------------------
  console.log('\n[8] Empty state');
  const empty = await js(`(async () => {
    window.__quickbill.showView('reports');
    await new Promise(r => setTimeout(r, 1000));
    const from = document.querySelector('[data-role="from"]');
    const to   = document.querySelector('[data-role="to"]');
    from.value='1999-01-01'; to.value='1999-01-02';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const txt = document.querySelector('[data-role="summary"]')?.innerText || '';
    return { txt, hasEmpty: /No sales|empty/i.test(txt) };
  })()`);
  check('reports show an empty state for a range with no sales', empty.hasEmpty === true,
    empty.txt.slice(0, 70).replace(/\n/g, ' '));
  await shot('reports-empty');

  // ---- 9. Application restart ------------------------------------------
  console.log('\n[9] Application restart persistence');
  const before = db.getSalesTodaySummary();
  const frozenBefore = db.getSale(fixture.todaySaleId).currency_code;
  db.close();
  db = require(path.join(REPO_ROOT, 'src', 'main', 'db.js')).createDatabase(path.join(OUT_DIR, 'userData'));
  const after = db.getSalesTodaySummary();
  const frozenAfter = db.getSale(fixture.todaySaleId).currency_code;
  check('sales survive a database reopen',
    after.saleCount === before.saleCount && after.totalPaise === before.totalPaise,
    `${after.saleCount} bills / ${after.totalPaise} paise`);
  check('frozen currency survives a reopen', frozenBefore === frozenAfter && frozenAfter === 'INR', frozenAfter);
  check('settings survive a reopen', db.getStoreSettings().storeName === 'QuickBill Smoke');

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ checks, failures, results }, null, 2));
}

app.whenReady().then(async () => {
  ensureDir(OUT_DIR);
  win = new BrowserWindow({
    width: 1360, height: 860, show: false,
    webPreferences: {
      preload: path.join(REPO_ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  // Surface renderer crashes instead of silently screenshotting a blank page.
  win.webContents.on('render-process-gone', (_e, d) => {
    failures++;
    console.error('  ✗ renderer process gone:', JSON.stringify(d));
  });
  try {
    await run({});
  } catch (err) {
    failures++;
    console.error('\nsmoke threw:', err && err.stack ? err.stack : err);
  }
  console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
  console.log(`Artifacts at: ${OUT_DIR}`);
  if (db) { try { db.close(); } catch (_e) {} }
  // Exit code is the whole point: a failing smoke must fail CI.
  app.exit(failures > 0 ? 1 : 0);
}).catch((err) => {
  console.error('smoke-ui failed:', err);
  app.exit(1);
});