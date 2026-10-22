// QuickBill — IPC handler registry (Phase 5).
//
// Extracted from main.js so the headless UI smoke can mount the EXACT same
// handlers the shipping app uses. Previously the smoke kept its own
// hand-copied subset, which silently drifted: it stubbed `receipt:print` to
// always succeed, so "printing works" was never actually exercised while the
// smoke still reported a pass.
//
// `createIpcHandlers({ db, listPrinters, printDocument })` returns a plain
// object of channel -> handler. main.js binds them to `ipcMain`; the smoke
// binds them to a stub `ipcMain` and can supply its own printer functions.

const { STORE_PROFILE_FIELDS, DEFAULT_STORE_PROFILE } = require('./db.js');

// Translate a thrown DB error into a serialisable payload the renderer can
// present to the user. Keep messages human-readable; never leak stack traces.
function serialiseDbError(err) {
  return {
    code:    err.code    || 'UNKNOWN',
    message: err.message || 'Unexpected database error.',
    field:   err.field   || null,
    errors:  err.errors  || null
  };
}

function createIpcHandlers({ db, getDb, listPrinters, printDocument, chooseBackupPath, inspectBackupFile, confirmRestore }) {
  // `getDb` is preferred over `db`: restoring a backup REPLACES the live
  // handle, so handlers must resolve the database per call rather than
  // capture a stale object at wiring time. Passing a plain `db` still works
  // for callers that never swap the handle (the headless smoke harness).
  const resolveDb = typeof getDb === 'function' ? getDb : () => db;
  if (!resolveDb()) throw new Error('createIpcHandlers: `db` or `getDb` is required');
  if (typeof listPrinters !== 'function') throw new Error('createIpcHandlers: `listPrinters` is required');
  if (typeof printDocument !== 'function') throw new Error('createIpcHandlers: `printDocument` is required');

  const ok = (data) => ({ ok: true, data });
  const fail = (err) => ({ ok: false, error: serialiseDbError(err) });

  return {
    // ---- Products ---------------------------------------------------------
    'products:list':        (filters) => { try { return ok(resolveDb().listProducts(filters || {})); } catch (e) { return fail(e); } },
    'products:get':         (id)      => { try { return ok(resolveDb().getProduct(id)); } catch (e) { return fail(e); } },
    'products:add':         (input)   => { try { return ok(resolveDb().addProduct(input)); } catch (e) { return fail(e); } },
    'products:update':      (input)   => { try { return ok(resolveDb().updateProduct(input)); } catch (e) { return fail(e); } },
    'products:delete':      (id)      => { try { return ok(resolveDb().deleteProduct(id)); } catch (e) { return fail(e); } },
    'products:categories':  ()        => { try { return ok(resolveDb().getCategories()); } catch (e) { return fail(e); } },
    'products:lowStock':    ()        => { try { return ok(resolveDb().getLowStock()); } catch (e) { return fail(e); } },
    'products:countLowStock': ()      => { try { return ok(resolveDb().countLowStock()); } catch (e) { return fail(e); } },
    'products:seedSample':  ()        => { try { return ok(resolveDb().seedSampleProducts()); } catch (e) { return fail(e); } },
    'products:dbInfo':      ()        => ok({ filePath: resolveDb().filePath }),

    // ---- Sales ------------------------------------------------------------
    'sales:create':    (payload) => { try { return ok(resolveDb().createSale(payload || {})); } catch (e) { return fail(e); } },
    'sales:get':       (id)      => { try { return ok(resolveDb().getSale(Number(id))); } catch (e) { return fail(e); } },
    'sales:getByBillNumber': (bill) => { try { return ok(resolveDb().getSaleByBillNumber(bill)); } catch (e) { return fail(e); } },
    'sales:list':      (filters) => { try { return ok(resolveDb().listSales(filters || {})); } catch (e) { return fail(e); } },
    'sales:todaySummary': ()     => { try { return ok(resolveDb().getSalesTodaySummary()); } catch (e) { return fail(e); } },
    // Books a month of backdated demo invoices through createSale(). The
    // timestamp override lives inside the DB layer (main-process only), so
    // this channel can generate history but the renderer still cannot forge
    // the created_at of a real checkout.
    'sales:seedDemo':  (payload) => {
      try { return ok(resolveDb().seedDemoSales(payload || {})); }
      catch (e) { return fail(e); }
    },

    // ---- Settings ---------------------------------------------------------
    'settings:getStore': () => { try { return ok(resolveDb().getStoreSettings()); } catch (e) { return fail(e); } },
    'settings:setTaxPercent': (percent) => {
      try { return ok({ taxPercent: resolveDb().setTaxPercent(percent) }); } catch (e) { return fail(e); }
    },
    'settings:setStoreProfile': (input) => { try { return ok(resolveDb().setStoreProfile(input || {})); } catch (e) { return fail(e); } },
    // Pure-data surface, no DB call: lets the renderer render the form.
    'settings:profileFields': () => ok({ fields: STORE_PROFILE_FIELDS, defaults: DEFAULT_STORE_PROFILE }),

    // ---- Backup / restore -------------------------------------------------
    // The renderer never passes a path: main.js owns the native file dialogs
    // and hands back whatever the operator actually chose.
    'db:info': () => { try { return ok({ filePath: resolveDb().filePath }); } catch (e) { return fail(e); } },

    'db:backup': async () => {
      try {
        if (typeof chooseBackupPath !== 'function') throw new Error('Backup is unavailable in this build.');
        const dest = await chooseBackupPath();
        if (!dest) return ok({ cancelled: true });
        return ok(await resolveDb().backupDatabase(dest));
      } catch (e) { return fail(e); }
    },

    'db:inspectBackup': async () => {
      try {
        if (typeof inspectBackupFile !== 'function') throw new Error('Restore is unavailable in this build.');
        const src = await inspectBackupFile();
        if (!src) return ok({ cancelled: true });
        return ok(resolveDb().inspectDatabase(src));
      } catch (e) { return fail(e); }
    },

    'db:restore': async () => {
      try {
        if (typeof inspectBackupFile !== 'function') throw new Error('Restore is unavailable in this build.');
        const src = await inspectBackupFile();
        if (!src) return ok({ cancelled: true });
        if (typeof confirmRestore !== 'function') throw new Error('Restore is unavailable in this build.');
        const inspection = resolveDb().inspectDatabase(src);
        const confirmed = await confirmRestore(inspection);
        if (!confirmed) return ok({ cancelled: true });
        return ok(resolveDb().restoreDatabase(src));
      } catch (e) { return fail(e); }
    },

    // ---- Receipts + printing ----------------------------------------------
    'receipt:forSale': (id) => {
      try {
        const sale = resolveDb().getSale(Number(id));
        if (!sale) {
          return { ok: false, error: { code: 'NOT_FOUND', message: `Bill #${id} not found.` } };
        }
        return ok(resolveDb().getReceiptProfile({ sale }));
      } catch (e) { return fail(e); }
    },

    'receipt:printers': async () => ok({ printers: await listPrinters() }),

    'receipt:print': async (input) => {
      try {
        if (!input || typeof input !== 'object' || typeof input.html !== 'string' || !input.html) {
          return { ok: false, error: { code: 'VALIDATION', message: 'Print request is missing receipt HTML.' } };
        }
        const printers = await listPrinters();
        if (printers.length === 0) {
          return {
            ok: false,
            error: {
              code: 'NO_PRINTER',
              message: 'No printer is configured on this Mac. Add one in System Settings → Printers & Scanners.'
            }
          };
        }
        const result = await printDocument({
          html: input.html,
          printer: input.printer || undefined,
          copies: input.copies || undefined
        });
        if (result.ok) return ok({ printerCount: printers.length });
        return { ok: false, error: { code: result.code, message: result.message } };
      } catch (e) { return fail(e); }
    },

    // ---- Phase 5 — dashboard / reports ------------------------------------
    'reports:dashboard': (filters) => {
      try {
        const f = filters || {};
        const handle = resolveDb();
        const summary     = handle.getSalesSummary({ from: f.from || '', to: f.to || '' });
        const bestSellers = handle.getBestSellers({ from: f.from || '', to: f.to || '', limit: Number(f.limit) || 8 });
        // "Today" must be an explicit local-day range. Passing `{}` here meant
        // "no bounds" = all-time, which the dashboard then labelled "bills today".
        const today       = handle.getSalesTodaySummary();
        // The card is captioned "Latest N invoices in range", so the range is
        // passed through rather than dropped on the floor.
        const recent      = handle.listRecentSales({
          from: f.from || '', to: f.to || '', limit: Number(f.recentLimit) || 8
        });
        const lowStock    = handle.getLowStock();
        const lowCount    = handle.countLowStock();
        const valuation   = handle.getInventoryValuation();
        const trend       = handle.getSalesDailyTrend({ from: f.from || '', to: f.to || '', limit: Number(f.trendLimit) || 14 });
        return ok({
          filters: f, summary, bestSellers, today, recent,
          lowStock, lowCount, valuation, trend
        });
      } catch (e) { return fail(e); }
    },
    'reports:salesSummary':       (filters) => { try { return ok(resolveDb().getSalesSummary(filters || {})); } catch (e) { return fail(e); } },
    'reports:bestSellers':        (filters) => { try { return ok(resolveDb().getBestSellers(filters || {})); } catch (e) { return fail(e); } },
    'reports:inventoryValuation': ()         => { try { return ok(resolveDb().getInventoryValuation()); } catch (e) { return fail(e); } },
    'reports:lowStock':           ()         => { try { return ok(resolveDb().getLowStock()); } catch (e) { return fail(e); } }
  };
}

module.exports = { createIpcHandlers, serialiseDbError };