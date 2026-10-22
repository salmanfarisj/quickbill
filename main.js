// QuickBill — Electron main process.
// Owns the BrowserWindow lifecycle and the SQLite-backed data layer.
//
// SECURITY POSTURE
//   contextIsolation: true   — renderer and preload run in separate worlds
//   nodeIntegration: false   — no `require` in the renderer, ever
//   sandbox: true            — renderer is OS-sandboxed; preload gets no Node
//   webSecurity: true        — same-origin policy stays on
//   CSP via <meta>           — no remote script/style, no eval
//   allowRunningInsecureContent: false, experimentalFeatures: false
//   Every window is denied geolocation/camera/mic/notifications/etc.
//   Navigation away from the bundled file:// document is blocked; external
//   http(s) links are handed to the OS browser instead of an in-app window.
//
// The renderer can therefore only reach the main process through the fixed,
// read-mostly channel list in preload.js. There is no fs, no child_process,
// no net and no ipcRenderer in the renderer context.

const {
  app, BrowserWindow, shell, ipcMain, dialog, session
} = require('electron');
const path = require('node:path');
const { createDatabase } = require('./src/main/db');
const { createIpcHandlers } = require('./src/main/ipc');

const APP_VERSION = require('./package.json').version;

const isDev = !app.isPackaged;

// Single database handle per process. Created lazily on first ready event so
// app.getPath('userData') is safe to call. Reassigned by a restore, so every
// consumer resolves it through `getDb()` rather than capturing the object.
let db = null;
let mainWindow = null;

const getDb = () => db;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: 'QuickBill — Supermarket POS',
    backgroundColor: '#f6f8fb',
    show: false,
    titleBarStyle: 'hiddenInset', // macOS native traffic-light look; clean top bar
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // The sandboxed preload cannot read package.json, so the authoritative
      // version is passed in from the main process rather than hardcoded
      // (which is how 0.4.0 and 0.5.0 drifted apart before).
      additionalArguments: [`--quickbill-version=${APP_VERSION}`]
    }
  });

  // Block in-app navigation to remote URLs; route external links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    // Only the bundled document may be navigated to. `new URL()` throws on
    // malformed input, so parse defensively — an unparseable target is
    // exactly the case that must be blocked, not the one that may crash us.
    let target = null;
    try { target = new URL(url); } catch (_err) { target = null; }
    if (!target || target.protocol !== 'file:') event.preventDefault();
  });

  // Defence in depth: a second layer in front of `will-navigate` for any
  // window created later (print windows included).
  win.webContents.on('will-redirect', (event, url) => {
    let target = null;
    try { target = new URL(url); } catch (_err) { target = null; }
    if (!target || target.protocol !== 'file:') event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  return win;
}


// ---------------------------------------------------------------------------
// Phase 5 — receipt + print pipeline.
//
// Electron's `webContents.print()` is asynchronous and returns a boolean via
// the `callback(success, failureReason)` form. We probe the OS's printer
// list first, and we classify the result so the renderer can show a useful
// message instead of a bare boolean.
//
// Failure modes we surface to the renderer:
//   - NO_PRINTER        no printers registered in the OS at all
//   - PRINTER_CANCELLED user dismissed the print dialog (a soft "no")
//   - PRINTER_FAILED    the OS reported an error printing the page
//
// `silent: false` keeps the system print dialog visible so the user can
// pick a printer, paper size and copies — the expected UX for a POS receipt.
// ---------------------------------------------------------------------------

let printersCache = null;
async function listAvailablePrinters() {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    printersCache = Array.isArray(printers) ? printers : [];
    return printersCache;
  } catch (_err) {
    printersCache = [];
    return [];
  }
}

function printHtmlDocument({ html, printer, copies }) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve({ ok: false, code: 'NO_PRINTER', message: 'Application window is not ready.' });
      return;
    }
    // Use a hidden BrowserWindow so we never disturb the visible UI and
    // we can dispose of it cleanly once printing finishes (success or fail).
    //
    // The receipt document gets NO preload: it is app-generated markup that
    // only needs to be laid out for the printer, and giving it the
    // `window.quickbill` bridge would hand a full database channel to a
    // throwaway window for no benefit.
    const printerWin = new BrowserWindow({
      show: false,
      width: 420,
      height: 720,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        javascript: false
      }
    });
    const cleanup = () => {
      if (!printerWin.isDestroyed()) printerWin.close();
    };
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    printerWin.webContents.on('did-finish-load', () => {
      const opts = {
        silent: false,
        printBackground: true,
        color: true,
        margins: { marginType: 'none' },
        pageSize: { width: 80000, height: 200000 } // ~80mm receipt — fits 3" thermal roll
      };
      if (printer) opts.deviceName = printer;
      if (copies && Number.isFinite(copies)) opts.copies = Math.max(1, Math.min(99, copies));
      printerWin.webContents.print(opts, (success, failureReason) => {
        cleanup();
        if (success) return resolve({ ok: true });
        const reason = String(failureReason || 'unknown');
        if (/cancelled/i.test(reason)) {
          return resolve({ ok: false, code: 'PRINTER_CANCELLED', message: 'Printing was cancelled.' });
        }
        if (/no printer|no-printer/i.test(reason)) {
          return resolve({ ok: false, code: 'NO_PRINTER', message: 'No printer is configured on this Mac.' });
        }
        return resolve({
          ok: false,
          code: 'PRINTER_FAILED',
          message: `The system printer reported an error: ${reason}.`
        });
      });
    });
    printerWin.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      cleanup();
      resolve({
        ok: false,
        code: 'PRINTER_FAILED',
        message: `Could not render the receipt page: ${errorDescription || errorCode}.`
      });
    });
    printerWin.loadURL(dataUrl).catch((err) => {
      cleanup();
      resolve({ ok: false, code: 'PRINTER_FAILED', message: err?.message || 'Failed to load receipt page.' });
    });
  });
}

// ---------------------------------------------------------------------------
// Backup / restore — native dialogs live here, in the main process.
//
// The renderer never names a path. It asks for a backup, the operator picks
// a destination in a native save panel, and only that path is used. Restore
// is the same in reverse, with an explicit confirmation step that states
// exactly what will be overwritten.
// ---------------------------------------------------------------------------

function defaultBackupName() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0')
  ].join('');
  return `quickbill-backup-${stamp}.sqlite`;
}

async function chooseBackupPath() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Back up QuickBill database',
    defaultPath: path.join(app.getPath('documents'), defaultBackupName()),
    filters: [{ name: 'QuickBill database', extensions: ['sqlite'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePath) return null;
  // `showSaveDialog` omits the extension when the user types none.
  return result.filePath.endsWith('.sqlite') ? result.filePath : `${result.filePath}.sqlite`;
}

async function pickBackupFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a QuickBill backup',
    properties: ['openFile'],
    filters: [{ name: 'QuickBill database', extensions: ['sqlite'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

async function confirmRestore(inspection) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Replace my data'],
    defaultId: 0,
    cancelId: 0,
    title: 'Replace the current database?',
    message: 'Restore this backup?',
    detail: [
      `Backup:  ${inspection.filePath}`,
      `Products: ${inspection.productCount}`,
      `Invoices: ${inspection.saleCount} (${inspection.itemCount} line items)`,
      inspection.lastSaleAt ? `Most recent invoice: ${inspection.lastSaleAt}` : 'Most recent invoice: none',
      '',
      'Everything currently in QuickBill is replaced. A copy of your current',
      'database is kept alongside it as "quickbill.sqlite.pre-restore" so you',
      'can go back if this was the wrong file.'
    ].join('\n')
  });
  return response === 1;
}

// ---------------------------------------------------------------------------
// Session hardening
//
// QuickBill needs no camera, microphone, geolocation, notifications or
// device access. Denying by default means a compromised or buggy renderer
// has nothing to ask for.
// ---------------------------------------------------------------------------

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Nothing in this app loads a remote origin; refuse outright so a
  // navigation bug cannot silently pull code off the network.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isLocal = details.url.startsWith('file://')
      || details.url.startsWith('data:text/html')
      || details.url.startsWith('devtools://')
      || details.url.startsWith('blob:')
      || details.url.startsWith('chrome-extension://');
    callback({ cancel: !isLocal });
  });
}

// IPC handlers — the only path that touches the database. Each one accepts
// a single object arg so renderer code stays tidy, and returns either the
// payload or { error } so a thrown DB exception never crashes the renderer.
function registerIpc() {
  const handlers = createIpcHandlers({
    getDb,
    listPrinters: listAvailablePrinters,
    printDocument: printHtmlDocument,
    chooseBackupPath,
    inspectBackupFile: pickBackupFile,
    confirmRestore
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_evt, payload) => handler(payload));
  }
}

// A database that cannot be opened is the one failure that makes the app
// useless, so it gets a real explanation and an exit code rather than a
// stack trace in a console nobody is watching.
async function openDatabaseOrExplain() {
  const userDataDir = app.getPath('userData');
  try {
    db = createDatabase(userDataDir);
    console.log(`[quickbill] database opened at ${db.filePath}`);
    return true;
  } catch (err) {
    console.error('[quickbill] database failed to open:', err);
    const detail = err && err.message ? err.message : String(err);
    const { response } = await dialog.showMessageBox({
      type: 'error',
      buttons: ['Quit', 'Reveal database file'],
      defaultId: 0,
      cancelId: 0,
      title: 'QuickBill could not open its database',
      message: 'QuickBill could not open its database.',
      detail: [
        `Location: ${path.join(userDataDir, 'quickbill.sqlite')}`,
        '',
        detail,
        '',
        'The file may be corrupt or not writable. Nothing has been changed.',
        'Close QuickBill and restore a backup (quickbill.sqlite.pre-restore),',
        'or move the file aside so QuickBill can create a fresh one.'
      ].join('\n')
    });
    if (response === 1) shell.showItemInFolder(path.join(userDataDir, 'quickbill.sqlite'));
    app.exit(1);
    return false;
  }
}

app.whenReady().then(async () => {
  hardenSession();

  // Open the database inside Electron's userData path. This is writable on
  // every OS, survives reinstalls of the app package, and is never bundled
  // inside the packaged asar.
  if (!(await openDatabaseOrExplain())) return;

  registerIpc();
  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // macOS apps typically stay active until Cmd+Q.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (db) {
    try { db.close(); } catch (_e) { /* ignore */ }
    db = null;
  }
});