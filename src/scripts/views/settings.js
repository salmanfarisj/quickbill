// QuickBill — Settings view, Phase 5.
//
// Configurable store profile:
//   storeName, storeAddress, storePhone, storeEmail, gstin,
//   currencyCode / currencySymbol / locale,
//   taxLabel, invoicePrefix, receiptFooter,
//   plus the Phase 4 default tax rate (% saved in the same `settings` table).
//
// All fields go through `setStoreProfile` in the main process, which
// validates them against STORE_PROFILE_FIELDS. The renderer shows the
// same description alongside every input.

// Resolved lazily: a module-scope dereference throws during app.js's static
// import if the preload bridge is missing, which blanks the entire shell.
const settingsApi = () => window.quickbill?.settings;
const receiptApi  = () => window.quickbill?.receipt;
const dbApi       = () => window.quickbill?.db;

const FIELD_DESCRIPTIONS = {
  storeName:      'Shown at the top of every receipt and on printed reports.',
  storeAddress:   'Address line printed beneath the store name. Optional.',
  storePhone:     'Phone line printed on receipts. Optional.',
  storeEmail:     'Email line printed on receipts. Optional.',
  gstin:          'Tax identification number printed on receipts. Optional.',
  currencyCode:   'ISO 4217 currency code (e.g. INR, USD, EUR). Three uppercase letters.',
  currencySymbol: 'Currency symbol prefixed to amounts (e.g. ₹, $, €).',
  locale:         'BCP-47 locale used for number formatting (e.g. en-IN, en-US).',
  taxLabel:       'Label used in the totals block instead of "Tax" (e.g. VAT, GST).',
  invoicePrefix:  'Prefix used to build bill numbers (default: INV).',
  receiptFooter:  'Text printed at the bottom of every receipt.',
  taxPercent:     'Default tax rate. Authoritatively applied to the post-discount subtotal at checkout.'
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderSettings() {
  const root = document.createElement('div');
  root.className = 'view view--settings';

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Settings</h1>
        <p>Store profile, currency, receipt footer and tax. Saved to the database; takes effect on the next receipt and report.</p>
      </div>
    </div>

    <div id="settingsState"></div>

    <div class="grid grid--two">

      <div class="card" data-role="store-card">
        <div class="card__header">
          <div>
            <div class="card__title">Store profile</div>
            <div class="card__subtitle">Printed on every receipt. Currency + locale drive number formatting.</div>
          </div>
        </div>
        <div class="card__body">
          <form class="settings-form" data-role="store-form" autocomplete="off">
            <div class="form-grid">
              <label class="form-field form-field--wide">
                <span class="form-label">Store name <span class="req">*</span></span>
                <input class="input" data-field="storeName" type="text" maxlength="120" required />
                <span class="form-error" data-role="err-storeName" hidden></span>
              </label>
              <label class="form-field form-field--wide">
                <span class="form-label">Address</span>
                <input class="input" data-field="storeAddress" type="text" maxlength="240" />
                <span class="form-error" data-role="err-storeAddress" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Phone</span>
                <input class="input" data-field="storePhone" type="text" maxlength="40" />
                <span class="form-error" data-role="err-storePhone" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Email</span>
                <input class="input" data-field="storeEmail" type="email" maxlength="120" />
                <span class="form-error" data-role="err-storeEmail" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">GSTIN / Tax ID</span>
                <input class="input" data-field="gstin" type="text" maxlength="32" />
                <span class="form-error" data-role="err-gstin" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Currency symbol</span>
                <input class="input" data-field="currencySymbol" type="text" maxlength="4" required />
                <span class="form-error" data-role="err-currencySymbol" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Currency code (ISO 4217)</span>
                <input class="input" data-field="currencyCode" type="text" pattern="[A-Za-z]{3}" maxlength="8" required />
                <span class="form-error" data-role="err-currencyCode" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Locale</span>
                <input class="input" data-field="locale" type="text" pattern="[a-z]{2}(-[A-Z]{2})?" maxlength="24" required />
                <span class="form-error" data-role="err-locale" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Tax label</span>
                <input class="input" data-field="taxLabel" type="text" maxlength="32" required />
                <span class="form-error" data-role="err-taxLabel" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Invoice prefix</span>
                <input class="input" data-field="invoicePrefix" type="text" maxlength="12" pattern="[A-Za-z0-9_-]+" required />
                <span class="form-error" data-role="err-invoicePrefix" hidden></span>
              </label>
              <label class="form-field form-field--wide">
                <span class="form-label">Receipt footer</span>
                <textarea class="input" data-field="receiptFooter" maxlength="240" rows="2"></textarea>
                <span class="form-error" data-role="err-receiptFooter" hidden></span>
              </label>
              <label class="form-field">
                <span class="form-label">Default tax rate (%)</span>
                <input class="input" data-field="taxPercent" type="number" step="0.01" min="0" max="1000" />
                <span class="form-error" data-role="err-taxPercent" hidden></span>
              </label>
            </div>

            <p class="muted" style="margin-top: 14px; font-size: 12.5px;">
              <strong>Tax compliance note.</strong> QuickBill stores this as a single flat percentage on the post-discount subtotal. The applicable GST/VAT rate must be verified by the operator for your jurisdiction before commercial use — the app does not codify tax law.
            </p>

            <div class="form-actions">
              <button type="button" class="btn" data-action="reset">Reset</button>
              <button type="submit" class="btn btn--primary">Save settings</button>
            </div>
            <div class="form-error form-error--top" data-role="form-error" hidden></div>
          </form>
        </div>
      </div>

      <div class="card" data-role="preview-card">
        <div class="card__header">
          <div>
            <div class="card__title">Receipt preview</div>
            <div class="card__subtitle">How the next printed receipt will look.</div>
          </div>
          <div class="pos-shortcuts" aria-hidden="true">
            <span><kbd>⌘</kbd>+<kbd>P</kbd> print</span>
          </div>
        </div>
        <div class="card__body" data-role="preview"></div>
      </div>

    </div>

    <div class="card" data-role="about-card" style="margin-top: 16px;">
      <div class="card__header">
        <div>
          <div class="card__title">Hardware & devices</div>
          <div class="card__subtitle">QuickBill prints through macOS's native print system.</div>
        </div>
      </div>
      <div class="card__body" data-role="printer-list" style="font-size: 13px; color: var(--text-2);">
        <p style="margin-top:0;">Loading installed printers…</p>
      </div>
    </div>

    <div class="card" data-role="backup-card" style="margin-top: 16px;">
      <div class="card__header">
        <div>
          <div class="card__title">Backup &amp; restore</div>
          <div class="card__subtitle">Your catalogue and every invoice live in one SQLite file. Keep a copy somewhere safe.</div>
        </div>
      </div>
      <div class="card__body" data-role="backup-body">
        <p style="margin-top:0;">Loading database location…</p>
      </div>
      <div class="form-actions" style="padding: 0 20px 20px;">
        <button type="button" class="btn" data-action="backup">Back up now…</button>
        <button type="button" class="btn btn--danger" data-action="restore">Restore from a backup…</button>
      </div>
    </div>

    <div class="toast" data-role="toast" hidden></div>
  `;

  const stateEl = root.querySelector('#settingsState');
  const formEl  = root.querySelector('[data-role="store-form"]');
  const formErrEl = root.querySelector('[data-role="form-error"]');
  const previewEl = root.querySelector('[data-role="preview"]');
  const printerListEl = root.querySelector('[data-role="printer-list"]');
  const backupBodyEl = root.querySelector('[data-role="backup-body"]');
  const toastEl  = root.querySelector('[data-role="toast"]');

  function setState(kind, message) {
    stateEl.innerHTML = `
      <div class="banner banner--${escapeHtml(kind)}" role="status">
        ${escapeHtml(message || '')}
      </div>`;
  }

  function showToast(message, kind = 'success') {
    toastEl.textContent = message;
    toastEl.className = `toast toast--${kind}`;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 2400);
  }

  function clearFieldErrors() {
    formEl.querySelectorAll('[data-role^="err-"]').forEach((el) => {
      el.hidden = true;
      el.textContent = '';
    });
    formErrEl.hidden = true;
    formErrEl.textContent = '';
  }

  function applyFieldErrors(errors) {
    clearFieldErrors();
    if (!errors || typeof errors !== 'object') return;
    let firstShown = false;
    for (const [field, msg] of Object.entries(errors)) {
      if (field === '_form') {
        formErrEl.textContent = msg;
        formErrEl.hidden = false;
        continue;
      }
      const errEl = formEl.querySelector(`[data-role="err-${field}"]`);
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
        firstShown = firstShown || true;
      }
    }
  }

  function readForm() {
    const input = {};
    for (const el of formEl.querySelectorAll('[data-field]')) {
      const field = el.dataset.field;
      if (field === 'taxPercent') {
        const n = Number(el.value);
        input[field] = Number.isFinite(n) ? n : '';
      } else {
        input[field] = String(el.value || '');
      }
    }
    return input;
  }

  function writeForm(profile) {
    for (const el of formEl.querySelectorAll('[data-field]')) {
      const field = el.dataset.field;
      const val = field === 'taxPercent' ? String(Number(profile.taxPercent) || 0) : String(profile[field] ?? '');
      el.value = val;
    }
  }

  function paintPreview(profile) {
    // Minimal receipt preview for the Settings card — full receipt
    // modals live in Billing and Sales History.
    previewEl.innerHTML = `
      <div class="receipt-preview">
        <div class="receipt-preview__head">
          <div class="receipt-preview__store">${escapeHtml(profile.storeName || '—')}</div>
          ${profile.storeAddress ? `<div class="receipt-preview__line">${escapeHtml(profile.storeAddress)}</div>` : ''}
          ${(profile.storePhone || profile.storeEmail) ? `<div class="receipt-preview__line">${escapeHtml([profile.storePhone, profile.storeEmail].filter(Boolean).join(' · '))}</div>` : ''}
          ${profile.gstin ? `<div class="receipt-preview__line">GSTIN: ${escapeHtml(profile.gstin)}</div>` : ''}
        </div>
        <div class="receipt-preview__divider"></div>
        <div class="receipt-preview__sample">
          <div><span>Subtotal</span><span>${escapeHtml(String(profile.currencySymbol || '₹'))}100.00</span></div>
          <div><span>${escapeHtml(profile.taxLabel || 'Tax')} (${Number(profile.taxPercent || 0).toFixed(2)}%)</span><span>${escapeHtml(String(profile.currencySymbol || '₹'))}${ (Number(profile.taxPercent || 0) * 1).toFixed(2) }</span></div>
          <div class="receipt-preview__total"><span>Total</span><span>${escapeHtml(String(profile.currencySymbol || '₹'))}${ (100 + Number(profile.taxPercent || 0)).toFixed(2) }</span></div>
        </div>
        <div class="receipt-preview__divider"></div>
        ${profile.receiptFooter
          ? `<div class="receipt-preview__footer">${escapeHtml(profile.receiptFooter)}</div>`
          : ''}
      </div>`;
  }

  async function refreshPreview() {
    const r = await settingsApi().getStore();
    if (!r.ok) {
      previewEl.innerHTML = `<div class="muted">Preview unavailable.</div>`;
      return;
    }
    paintPreview(r.data);
  }

  // ---- Backup & restore -------------------------------------------------
  // Both actions hand control to a native macOS dialog owned by the main
  // process. The renderer never names a path.
  function formatBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function refreshBackupPanel() {
    const db = dbApi();
    if (!db?.info) {
      backupBodyEl.innerHTML = `<p style="margin-top:0;">Backup API is not available in this build.</p>`;
      return;
    }
    const r = await db.info();
    if (!r.ok) {
      backupBodyEl.innerHTML = `<p style="margin-top:0; color: var(--error);">Could not read the database location: ${escapeHtml(r.error?.message || 'unknown error')}</p>`;
      return;
    }
    backupBodyEl.innerHTML = `
      <p style="margin-top:0; margin-bottom: 6px;">
        <strong>Database file</strong><br />
        <code class="muted-code">${escapeHtml(r.data.filePath)}</code>
      </p>
      <p class="muted" style="margin-bottom: 0; font-size: 12px;">
        Backups are full copies taken safely while the app is running — it is
        safe to back up mid-shift. Keep them off this Mac (USB stick, cloud
        folder) so a stolen or lost machine does not take the ledger with it.
      </p>`;
  }

  async function handleBackup() {
    const db = dbApi();
    if (!db?.backup) return;
    const r = await db.backup();
    if (!r.ok) {
      showToast(r.error?.message || 'Backup failed.', 'error');
      return;
    }
    if (r.data.cancelled) {
      showToast('Backup cancelled.');
      return;
    }
    showToast(`Backup written to ${r.data.filePath} (${formatBytes(r.data.bytes)}).`);
  }

  async function handleRestore() {
    const db = dbApi();
    if (!db?.restore) return;
    const r = await db.restore();
    if (!r.ok) {
      showToast(r.error?.message || 'Restore failed.', 'error');
      return;
    }
    if (r.data.cancelled) {
      showToast('Restore cancelled.');
      return;
    }
    showToast(`Restored ${r.data.saleCount} invoice(s) and ${r.data.productCount} product(s).`);
    // The ledger was replaced underneath the app: every cached view is now
    // showing data that no longer exists.
    await Promise.all([refresh(), refreshBackupPanel(), refreshPrinters()]);
    window.dispatchEvent(new CustomEvent('quickbill:settings-updated'));
    window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
  }

  async function refresh() {
    setState('loading', 'Loading current settings…');
    const r = await settingsApi().getStore();
    if (!r.ok) {
      setState('error', `Could not load settings: ${r.error.message || 'unknown error'}`);
      return;
    }
    stateEl.innerHTML = '';
    writeForm(r.data);
    clearFieldErrors();
    paintPreview(r.data);
  }

  async function refreshPrinters() {
    if (!receiptApi()?.printers) {
      printerListEl.innerHTML = `<p style="margin-top:0;">Printer API is not available in this build.</p>`;
      return;
    }
    const r = await receiptApi().printers();
    if (!r.ok) {
      printerListEl.innerHTML = `<p style="margin-top:0;">Could not list printers: ${escapeHtml(r.error?.message || 'unknown error')}</p>`;
      return;
    }
    const list = (r.data?.printers || []);
    if (list.length === 0) {
      printerListEl.innerHTML = `
        <p style="margin-top:0;">
          <strong>No printers detected.</strong>
          macOS exposes printers via the system print spooler. Open
          <em>System Settings → Printers &amp; Scanners</em> and add at
          least one printer (any model, or the <em>PDF</em> virtual
          printer) before printing receipts.
        </p>`;
      return;
    }
    printerListEl.innerHTML = `
      <ul style="margin: 0; padding-left: 18px;">
        ${list.map((p) => `
          <li>
            <strong>${escapeHtml(p.name || '(unnamed)')}</strong>
            ${p.displayName && p.displayName !== p.name ? ` · ${escapeHtml(p.displayName)}` : ''}
            ${p.description ? `<div class="muted" style="font-size: 12px;">${escapeHtml(p.description)}</div>` : ''}
          </li>`).join('')}
      </ul>`;
  }

  async function save(ev) {
    ev.preventDefault();
    const input = readForm();
    setState('saving', 'Saving settings to the database…');
    const r = await settingsApi().setStoreProfile(input);
    if (!r.ok) {
      setState('error', `Could not save settings: ${r.error.message || 'validation failed'}`);
      applyFieldErrors(r.error?.errors || {});
      showToast('Settings were not saved.', 'error');
      return;
    }
    applyFieldErrors({});
    setState('success', 'Settings saved. Receipts and reports use the new values.');
    writeForm(r.data);
    paintPreview(r.data);
    showToast('Settings saved successfully.');
    // Surface to the rest of the app: billing view re-reads the tax
    // rate on next open, and any open dashboard will pick up currency
    // changes on its next refresh.
    window.dispatchEvent(new CustomEvent('quickbill:settings-updated'));
    window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
  }

  formEl.addEventListener('submit', save);
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'reset') {
      clearFieldErrors();
      refresh();
      return;
    }
    if (btn.dataset.action === 'backup') return handleBackup();
    if (btn.dataset.action === 'restore') return handleRestore();
  });

  refresh();
  refreshPrinters();
  refreshBackupPanel();

  return {
    el: root,
    dispose() {
      clearTimeout(showToast._t);
    }
  };
}
