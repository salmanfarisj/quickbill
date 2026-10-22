// QuickBill — preload script.
//
// Runs in an isolated, sandboxed context. The only surface exposed to the
// renderer is a tiny, well-typed namespace via contextBridge. No Node APIs
// leak: the renderer gets no `require`, no `process` (beyond the two
// immutable strings below), no `fs`, no `child_process` and no raw
// `ipcRenderer`.
//
// Every IPC call goes through `invoke`, which returns a promise. The main
// process either replies with { ok: true, data } or { ok: false, error },
// so renderer code can branch without try/catch gymnastics.
//
// SECURITY: only the channels named below are reachable from the renderer.
// Each is a fixed, parameterised call into a validated main-process handler —
// there is deliberately no generic `send(channel, payload)` escape hatch, so a
// script injected into the renderer still cannot reach an arbitrary handler,
// read a file, or pass a filesystem path to the database layer.

const { contextBridge, ipcRenderer } = require('electron');

// Passed in from the main process via webPreferences.additionalArguments —
// a sandboxed preload cannot read package.json itself, and hardcoding the
// version here is how it drifted out of sync with the real release before.
const versionArg = process.argv.find((a) => a.startsWith('--quickbill-version='));
const APP_VERSION = versionArg ? versionArg.slice('--quickbill-version='.length) : '0.0.0';

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('quickbill', {
  platform: process.platform,
  app: {
    name: 'QuickBill',
    version: APP_VERSION
  },

  // Database-backed product operations. All calls return
  //   { ok: true, data } | { ok: false, error: { code, message, field, errors } }
  products: {
    list:        (filters)   => invoke('products:list',          filters || {}),
    get:         (id)        => invoke('products:get',           id),
    add:         (input)     => invoke('products:add',           input),
    update:      (input)     => invoke('products:update',        input),
    delete:      (id)        => invoke('products:delete',        id),
    categories:  ()          => invoke('products:categories'),
    lowStock:    ()          => invoke('products:lowStock'),
    countLowStock: ()        => invoke('products:countLowStock'),
    seedSample:  ()          => invoke('products:seedSample'),
    dbInfo:      ()          => invoke('products:dbInfo')
  },

  // ---- Sales ledger ----
  // The main process is the only authority on prices, stock and totals; the
  // renderer never sends "unit_price" or "stock_quantity" along with the
  // cart — it only sends barcode + quantity, and the checkout in the main
  // process recomputes everything from the products table in one
  // transaction.
  sales: {
    create:       (payload) => invoke('sales:create',         payload || {}),
    get:          (id)      => invoke('sales:get',            Number(id)),
    getByBill:    (bill)    => invoke('sales:getByBillNumber', String(bill || '')),
    list:         (filters) => invoke('sales:list',           filters || {}),
    todaySummary: ()        => invoke('sales:todaySummary'),
    // Books demo history. Accepts only the day-count option; the backdated
    // timestamps are generated in the main process and cannot be supplied
    // (or overridden) from here.
    seedDemo:     (options) => invoke('sales:seedDemo', options || {})
  },

  // ---- Store settings (profile + tax) ----
  settings: {
    getStore:          ()                 => invoke('settings:getStore'),
    setStoreProfile:   (input)            => invoke('settings:setStoreProfile', input || {}),
    profileFields:     ()                 => invoke('settings:profileFields'),
    setTaxPercent:     (percent)          => invoke('settings:setTaxPercent', Number(percent))
  },

  // ---- Receipts + printing ----
  receipt: {
    forSale:   (id)               => invoke('receipt:forSale', Number(id)),
    printers:  ()                 => invoke('receipt:printers'),
    print:     (payload)          => invoke('receipt:print',   payload || {})
  },

  // ---- Dashboard + reports ----
  reports: {
    dashboard:         (filters) => invoke('reports:dashboard',         filters || {}),
    salesSummary:      (filters) => invoke('reports:salesSummary',      filters || {}),
    bestSellers:       (filters) => invoke('reports:bestSellers',       filters || {}),
    inventoryValuation:()        => invoke('reports:inventoryValuation'),
    lowStock:          ()        => invoke('reports:lowStock')
  },

  // ---- Backup / restore ----
  // None of these accept a path. The main process opens a native file
  // dialog, the operator picks the file, and only that result is used — so
  // the renderer can never name a location on disk.
  db: {
    info:         ()      => invoke('db:info'),
    backup:       ()      => invoke('db:backup'),
    inspectBackup:()     => invoke('db:inspectBackup'),
    restore:      ()      => invoke('db:restore')
  }
});