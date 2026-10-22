// QuickBill — one-shot screenshot capture for mockup screens.
//
// Boots the SAME data + IPC layer the shipping app uses (see
// tools/smoke-ui-phase5.js for the proven pattern), but in an isolated
// userData directory so the user's real quickbill.sqlite is never touched.
// Seeds products, the store profile, and a handful of backdated sales so
// Dashboard / Sales History / Reports have realistic rows, then captures
// every view via webContents.capturePage().
//
// Run with the project's Electron:
//   npx electron tools/screenshot.js
//
// Optional env:
//   OUT_DIR=/some/path   override the default mockups dir
//   VIEW=dashboard       capture one view and exit (also accepts comma-list,
//                        e.g. VIEW="dashboard,billing")
//   SEED=0               skip sample-data seeding (capture empty states)
//   CLEAN=1              wipe OUT_DIR before capturing

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const OUT_DIR   = process.env.OUT_DIR
  || path.join(REPO_ROOT, 'mockups');
const ONLY_VIEW = process.env.VIEW || '';
const SKIP_SEED = process.env.SEED === '0';
const DO_CLEAN  = process.env.CLEAN === '1';

// All side effects of the run live here; never touches the shipping DB.
const USER_DATA_DIR = path.join(OUT_DIR, 'userData');

const WINDOW_W = 1360;
const WINDOW_H = 860;

const VIEW_ORDER = [
  'dashboard',
  'billing',
  'products',
  'inventory',
  'sales-history',
  'reports',
  'settings'
];

// How long to wait after `navigate()` before capturePage. Async views
// (inventory, dashboard, billing) each need a separate buffer.
const VIEW_SETTLE_MS = {
  dashboard:     1500,
  billing:       1500,
  products:       900,
  inventory:     2000,
  'sales-history':900,
  reports:        900,
  settings:       900
};

// ── Bootstrap ────────────────────────────────────────────────────────────
if (DO_CLEAN) fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// Headless-friendly GPU config; capturePage works either way but this
// avoids shader-cache issues on first launch.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.disableHardwareAcceleration();

// Isolate everything from the shipping app's state.
app.setPath('userData', USER_DATA_DIR);

// ── Database + IPC (mirrors the smoke harness exactly) ───────────────────
let db = null;

function registerRealIpc(winRef) {
  const { createIpcHandlers } = require(path.join(REPO_ROOT, 'src', 'main', 'ipc.js'));

  const listPrinters = async () => {
    try { return await winRef.webContents.getPrintersAsync(); }
    catch (_e) { return []; }
  };

  // Stub print: the screenshot run never actually needs to print.
  const printDocument = () => Promise.resolve(
    { ok: false, code: 'NO_PRINTER', message: 'Screenshots do not print.' }
  );

  const handlers = createIpcHandlers({ db, listPrinters, printDocument });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_evt, payload) => handler(payload));
  }
  return { listPrinters, printDocument };
}

// ── Seeding ──────────────────────────────────────────────────────────────
function seedDatabase() {
  const { createDatabase, SAMPLE_PRODUCTS } = require(path.join(REPO_ROOT, 'src', 'main', 'db.js'));

  // Fresh DB on every run so screenshots are deterministic and never show
  // rows left over from a previous attempt.
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  db = createDatabase(USER_DATA_DIR);
  db.seedSampleProducts();

  // Realistic store profile so receipts and headers are populated.
  db.setStoreProfile({
    storeName:     'BrightMart Supermarket',
    storeAddress:  '12 Market Street, Bengaluru',
    storePhone:    '+91 80 4000 1100',
    currencyCode:  'INR',
    currencySymbol:'₹',
    locale:        'en-IN',
    taxLabel:      'GST',
    invoicePrefix: 'INV',
    receiptFooter: 'Thank you for shopping with us!',
    taxPercent:    5
  });

  // Backdate a handful of sales across the last few days so Dashboard,
  // Sales History and Reports have meaningful buckets.
  const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
  const raw = new Database(db.filePath);
  const stampCreatedAt = (id, daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    // Mix morning and afternoon stamps so the time-of-day column looks varied.
    if (daysAgo % 2 === 0) d.setHours(11, 12, 0, 0);
    else d.setHours(17, 45, 0, 0);
    const utc = d.toISOString().slice(0, 19).replace('T', ' ');
    raw.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(utc, id);
  };

  const barcodeOf = (name) => {
    const sp = SAMPLE_PRODUCTS.find((p) => p.name === name);
    return sp ? sp.barcode : null;
  };

  const plan = (name, qty) => ({ barcode: barcodeOf(name), quantity: qty });

  const records = [];
  // Today, multiple transactions.
  records.push({ items: [plan('Sparkling Water 1L', 2), plan('Greek Yogurt 500g', 1)],
                 pay: { method: 'cash', amountReceivedPaise: 1500 }, tax: 0, discount: 0,
                 customer: 'Walk-in', cashier: 'Salman K.', shift: 0 });
  records.push({ items: [plan('Sourdough Loaf', 1), plan('Bananas (1 kg)', 2),
                          plan('Olive Oil 500ml', 1)],
                 pay: { method: 'cash', amountReceivedPaise: 2500 }, tax: 5, discount: 100,
                 customer: 'Anita R.', cashier: 'Salman K.', shift: 0 });
  // Yesterday.
  records.push({ items: [plan('Whole Milk 1L', 3), plan('Dark Chocolate Bar 100g', 1)],
                 pay: { method: 'cash', amountReceivedPaise: 1000 }, tax: 0, discount: 0,
                 customer: 'Walk-in', cashier: 'Salman K.', shift: 1 });
  records.push({ items: [plan('Frozen Peas 500g', 2), plan('Brown Rice 1 kg', 1)],
                 pay: { method: 'unpaid', amountReceivedPaise: 0 }, tax: 0, discount: 50,
                 customer: 'Priya S.', cashier: 'Salman K.', shift: 1 });
  // 2 days ago.
  records.push({ items: [plan('Laundry Detergent 1L', 1), plan('Toilet Paper 9-pack', 1)],
                 pay: { method: 'cash', amountReceivedPaise: 2000 }, tax: 5, discount: 0,
                 customer: 'Karthik M.', cashier: 'Salman K.', shift: 2 });
  // 3 days ago.
  records.push({ items: [plan('Orange Juice 1L', 2), plan('Salted Potato Chips 150g', 3)],
                 pay: { method: 'cash', amountReceivedPaise: 1200 }, tax: 2.5, discount: 0,
                 customer: 'Walk-in', cashier: 'Salman K.', shift: 3 });

  let inserted = 0;
  let failed = 0;
  for (const r of records) {
    try {
      const ok = db.createSale({
        items:        r.items,
        payment:      r.pay,
        taxPercent:   r.tax,
        discountPaise:r.discount,
        customerName: r.customer,
        cashierName:  r.cashier,
        clientRequestId: `shot-seed-${inserted + 1}-${Date.now()}`
      });
      stampCreatedAt(ok.sale.id, r.shift);
      inserted++;
    } catch (_e) {
      failed++;
    }
  }
  raw.close();
  return { inserted, failed };
}

// ── Window ───────────────────────────────────────────────────────────────
let win = null;

function createMainWindow() {
  win = new BrowserWindow({
    width:  WINDOW_W,
    height: WINDOW_H,
    show:   false,
    backgroundColor: '#f6f8fb',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(REPO_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--quickbill-version=0.4.0`]
    }
  });

  win.webContents.on('will-navigate', (e, url) => {
    let t = null; try { t = new URL(url); } catch (_) { t = null; }
    if (!t || t.protocol !== 'file:') e.preventDefault();
  });

  // Forward renderer console so seed/IPC errors surface in the harness log.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = level === 'error' ? '[renderer:ERROR]' : '[renderer]';
    console.log(tag, message, sourceId ? `(${sourceId}:${line})` : '');
  });
  win.loadFile(path.join(REPO_ROOT, 'src', 'index.html'));
  return win;
}

// ── Renderer-side helpers ────────────────────────────────────────────────
async function waitForBridge() {
  for (let i = 0; i < 80; i++) {
    const ready = await win.webContents.executeJavaScript(
      'Boolean(window.quickbill && window.__quickbill)', true
    );
    if (ready) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Renderer bridge never appeared.');
}

async function notifyDataChanged() {
  await win.webContents.executeJavaScript(
    'window.dispatchEvent(new CustomEvent("quickbill:data-changed"))', true
  );
}

async function settle(ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
}

async function navigate(viewName) {
  await win.webContents.executeJavaScript(
    `window.__quickbill.navigate(${JSON.stringify(viewName)})`, true
  );
}

// Per-view cosmetic tweaks that need the DOM of the active view.
// Each entry returns true/false so the caller knows if it actually applied.
const VIEW_POLISH = {
  dashboard: async () => {
    // Widen the range to "last 7 days" so the trend chart is a real curve.
    return win.webContents.executeJavaScript(`(() => {
      const fromEl = document.querySelector('[data-role="from"]');
      const toEl   = document.querySelector('[data-role="to"]');
      if (!fromEl || !toEl) return false;
      const today = new Date();
      const ago   = new Date(); ago.setDate(today.getDate() - 6);
      const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      fromEl.value = fmt(ago);
      toEl.value   = fmt(today);
      fromEl.dispatchEvent(new Event('change', { bubbles: true }));
      toEl.dispatchEvent(new Event('change',   { bubbles: true }));
      return true;
    })()`, true);
  },

  billing: async () => {
    // Seed an in-progress cart so the screenshot shows real line items +
    // a non-empty totals panel (the default state is an empty cart).
    return win.webContents.executeJavaScript(`(async () => {
      const api = window.quickbill;
// Find three popular products by name and grab their barcodes via the
    // catalogue, then dispatch the same quickbill:quick-pick event the
    // app's quick search uses so the live cart picks them up.
      const list = await api.products.list();
      if (!list.ok) return false;
      const want = (q) => list.data.find(p => p.name === q);
      const items = ['Sparkling Water 1L', 'Greek Yogurt 500g', 'Bananas (1 kg)', 'Olive Oil 500ml']
        .map(n => want(n)).filter(Boolean).slice(0, 3);
      for (const it of items) {
        window.dispatchEvent(new CustomEvent('quickbill:quick-pick', { detail: { kind: 'product', id: it.barcode } }));
        await new Promise(r => setTimeout(r, 80));
      }
      // Set a customer name and a small cash tender so the payment panel
      // reflects a typical checkout.
      const nameInput = document.querySelector('[data-role="customer-name"]');
      if (nameInput) {
        nameInput.value = 'Anita R.';
        nameInput.dispatchEvent(new Event('input',  { bubbles: true }));
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`, true);
  }
};

async function capture(viewName) {
  await navigate(viewName);
  await settle(900);
  const polish = VIEW_POLISH[viewName];
  if (polish) {
    try { await polish(); }
    catch (e) { console.warn(`[polish] ${viewName}: ${e.message}`); }
  }
  await settle(VIEW_SETTLE_MS[viewName] || 900);
  const img = await win.webContents.capturePage();
  if (img.isEmpty()) throw new Error(`capturePage returned empty image for ${viewName}`);
  const png = img.toPNG();
  const out = path.join(OUT_DIR, `${viewName}.png`);
  fs.writeFileSync(out, png);
  const bytes = fs.statSync(out).size;
  return { viewName, out, bytes };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  let seedReport = null;
  if (!SKIP_SEED) seedReport = seedDatabase();

  createMainWindow();
  registerRealIpc(win);

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await waitForBridge();
  await settle(400);

  if (!SKIP_SEED) {
    // Views that mounted before the seed finished holding stale data
    // (especially Dashboard, Products, Inventory) need to refetch.
    await notifyDataChanged();
    await settle(300);
  }

  const targets = (ONLY_VIEW
    ? ONLY_VIEW.split(',').map((s) => s.trim()).filter(Boolean)
    : VIEW_ORDER);

  const results = [];
  for (const v of targets) {
    try {
      const r = await capture(v);
      results.push(r);
      console.log(`[capture] ${v}: ${r.bytes} bytes  -> ${r.out}`);
    } catch (e) {
      console.error(`[capture] ${v} failed: ${e.message}`);
      results.push({ viewName: v, error: e.message });
    }
  }

  console.log('\n=== Screenshot summary ===');
  console.log('output dir :', OUT_DIR);
  console.log('user data  :', USER_DATA_DIR);
  if (seedReport) console.log('seed       :', JSON.stringify(seedReport));
  for (const r of results) console.log('  ', JSON.stringify(r));
}

app.whenReady().then(async () => {
  try { await main(); }
  catch (err) { console.error('[fatal]', err); process.exitCode = 1; }
  finally    { app.quit(); }
}).catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

app.on('window-all-closed', () => app.quit());
