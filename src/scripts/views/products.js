// QuickBill — Products view.
// Talks to the database through the `window.quickbill.products` API that
// preload.js maps to ipcRenderer.invoke('products:*'). No direct DB access
// here, by design.
//
// Money note: `cost_price` / `selling_price` are RUPEES stored in a REAL
// column. They are converted to integer PAISE once and formatted with the
// STORE PROFILE, so this screen can never contradict the till (which uses
// the same profile) or the receipts.

import { formatCurrency } from '../lib/money.js';

// Resolved lazily. A module-scope `window.quickbill.products` throws during
// app.js's static import if the preload bridge is missing, which blanks the
// entire shell instead of just this view.
const api = () => window.quickbill?.products;

const numFmt = new Intl.NumberFormat('en-IN');

// Rupees (DB REAL) → integer paise.
function toPaise(rupees) { return Math.round(Number(rupees || 0) * 100); }

function formatInt(n) { return numFmt.format(Number(n) || 0); }

// Store profile is fetched once per session; formatCurrency falls back to
// ₹ / en-IN when it is missing or malformed.
let cachedProfile = null;
async function loadStoreProfile() {
  if (cachedProfile) return cachedProfile;
  try {
    const res = await window.quickbill?.settings?.getStore?.();
    if (res && res.ok && res.data) cachedProfile = res.data;
  } catch (_err) {
    // Defaults are fine — formatCurrency has them built in.
  }
  return cachedProfile;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function stockPill(stock, min) {
  const low = Number(stock) <= Number(min);
  const label = low ? 'Low stock' : 'In stock';
  return `<span class="pill ${low ? 'pill--low' : 'pill--ok'}">${label}</span>`;
}

// Build a <select> with the given options and selected value.
function buildSelect(name, options, selectedValue, { placeholder } = {}) {
  const opts = (placeholder
    ? `<option value="">${escapeHtml(placeholder)}</option>`
    : '') + options.map(opt => {
      const value = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? opt.label  : opt;
      const sel   = String(value) === String(selectedValue ?? '') ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');
  return `<select class="input" name="${name}">${opts}</select>`;
}

function emptyState(message) {
  return `
    <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">
      ${escapeHtml(message)}
    </div>`;
}

function renderRow(product, profile) {
  const low = Number(product.stock_quantity) <= Number(product.min_stock_level);
  return `
    <tr data-id="${product.id}" class="${low ? 'row--low' : ''}">
      <td><code>${escapeHtml(product.sku)}</code></td>
      <td><code class="muted-code">${escapeHtml(product.barcode)}</code></td>
      <td>${escapeHtml(product.name)}</td>
      <td><span class="pill pill--category">${escapeHtml(product.category)}</span></td>
      <td class="num">${escapeHtml(formatCurrency(toPaise(product.cost_price), profile))}</td>
      <td class="num">${escapeHtml(formatCurrency(toPaise(product.selling_price), profile))}</td>
      <td class="num">${formatInt(product.stock_quantity)}</td>
      <td class="num">${formatInt(product.min_stock_level)}</td>
      <td>${stockPill(product.stock_quantity, product.min_stock_level)}</td>
      <td class="actions">
        <button class="btn btn--ghost" data-action="edit" data-id="${product.id}">Edit</button>
        <button class="btn btn--danger" data-action="delete" data-id="${product.id}">Delete</button>
      </td>
    </tr>`;
}

function renderTable(products, profile) {
  if (!products.length) return emptyState('No products match your filters yet.');
  const rows = products.map((p) => renderRow(p, profile)).join('');
  return `
    <table class="table">
      <thead>
        <tr>
          <th>SKU</th><th>Barcode</th><th>Product</th><th>Category</th>
          <th class="num">Cost</th><th class="num">Price</th>
          <th class="num">Stock</th><th class="num">Reorder at</th>
          <th>Status</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Form (Add / Edit)
// ---------------------------------------------------------------------------

function emptyForm() {
  return {
    id: '', barcode: '', sku: '', name: '', category: 'General',
    cost_price: '', selling_price: '', stock_quantity: '', min_stock_level: ''
  };
}

function formFromProduct(p) {
  return {
    id:              p.id,
    barcode:         p.barcode,
    sku:             p.sku,
    name:            p.name,
    category:        p.category,
    cost_price:      p.cost_price,
    selling_price:   p.selling_price,
    stock_quantity:  p.stock_quantity,
    min_stock_level: p.min_stock_level
  };
}

function renderForm({ form, categories, errors, isEdit }) {
  const err = (key) => errors && errors[key] ? ` <span class="form-error">${escapeHtml(errors[key])}</span>` : '';
  const categorySelect = buildSelect('category', categories, form.category);
  return `
    <form class="product-form" autocomplete="off">
      ${isEdit ? `<input type="hidden" name="id" value="${escapeHtml(form.id)}">` : ''}
      <div class="form-grid">
        <label class="form-field">
          <span class="form-label">Barcode ${err('barcode')}</span>
          <input class="input" name="barcode" value="${escapeHtml(form.barcode)}" placeholder="e.g. 8901030120049" />
        </label>
        <label class="form-field">
          <span class="form-label">SKU ${err('sku')}</span>
          <input class="input" name="sku" value="${escapeHtml(form.sku)}" placeholder="e.g. SNK-077" />
        </label>
        <label class="form-field form-field--wide">
          <span class="form-label">Product name ${err('name')}</span>
          <input class="input" name="name" value="${escapeHtml(form.name)}" placeholder="e.g. Dark Chocolate Bar 100g" />
        </label>
        <label class="form-field">
          <span class="form-label">Category ${err('category')}</span>
          ${categorySelect}
        </label>
        <label class="form-field">
          <span class="form-label">Cost price ${err('cost_price')}</span>
          <input class="input" type="number" step="0.01" min="0" name="cost_price" value="${escapeHtml(form?.cost_price)}" />
        </label>
        <label class="form-field">
          <span class="form-label">Selling price ${err('selling_price')}</span>
          <input class="input" type="number" step="0.01" min="0" name="selling_price" value="${escapeHtml(form?.selling_price)}" />
        </label>
        <label class="form-field">
          <span class="form-label">Stock quantity ${err('stock_quantity')}</span>
          <input class="input" type="number" step="1" min="0" name="stock_quantity" value="${escapeHtml(form?.stock_quantity)}" />
        </label>
        <label class="form-field">
          <span class="form-label">Minimum stock ${err('min_stock_level')}</span>
          <input class="input" type="number" step="1" min="0" name="min_stock_level" value="${escapeHtml(form?.min_stock_level)}" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn btn--primary">${isEdit ? 'Save changes' : 'Add product'}</button>
      </div>
    </form>`;
}

function readForm(formEl) {
  const fd = new FormData(formEl);
  return {
    id:              fd.get('id') || '',
    barcode:         String(fd.get('barcode') || '').trim(),
    sku:             String(fd.get('sku') || '').trim(),
    name:            String(fd.get('name') || '').trim(),
    category:        String(fd.get('category') || '').trim() || 'General',
    cost_price:      fd.get('cost_price'),
    selling_price:   fd.get('selling_price'),
    stock_quantity:  fd.get('stock_quantity'),
    min_stock_level: fd.get('min_stock_level')
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderProducts() {
  const root = document.createElement('div');
  root.className = 'view view--products';

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Products</h1>
        <p>Manage your catalogue — SKUs, barcodes, prices and stock levels.</p>
      </div>
      <div class="page-header__actions">
        <button class="btn" data-action="seed">Add sample products</button>
        <button class="btn btn--primary" data-action="new">+ Add product</button>
      </div>
    </div>

    <div class="card">
      <div class="card__header toolbar">
        <input class="input toolbar__search" type="search" placeholder="Search by name, SKU or barcode…" aria-label="Search products" />
        <select class="input toolbar__filter" aria-label="Filter by category">
          <option value="">All categories</option>
        </select>
        <span class="toolbar__spacer"></span>
        <span class="toolbar__count" data-role="count">—</span>
      </div>
      <div class="card__body" style="padding: 0;" data-role="table">
        <div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">Loading products…</div>
      </div>
    </div>

    <div class="modal" data-role="modal" hidden></div>

    <div class="toast" data-role="toast" hidden></div>
  `;

  // ---- element refs ----
  const searchEl = root.querySelector('.toolbar__search');
  const filterEl = root.querySelector('.toolbar__filter');
  const countEl  = root.querySelector('[data-role="count"]');
  const tableEl  = root.querySelector('[data-role="table"]');
  const modalEl  = root.querySelector('[data-role="modal"]');
  const toastEl  = root.querySelector('[data-role="toast"]');

  let currentProducts = [];
  let currentCategories = ['General'];
  let searchTerm = '';
  let categoryFilter = '';
  let profile = null;
  let disposed = false;
  let searchDebounce = null;

  function showToast(message, kind = 'success') {
    toastEl.textContent = message;
    toastEl.className = `toast toast--${kind}`;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 2800);
  }

  async function refreshCategories() {
    const res = await api().categories();
    if (!res.ok) return;
    currentCategories = Array.isArray(res.data) ? res.data : ['General'];
    if (disposed || !filterEl.isConnected) return;
    filterEl.innerHTML = currentCategories.map(c =>
      `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
    ).join('');
    if (categoryFilter) filterEl.value = categoryFilter;
  }

  async function refreshTable() {
    const res = await api().list({ search: searchTerm, category: categoryFilter });
    if (disposed || !tableEl.isConnected) return;
    if (!res.ok) {
      tableEl.innerHTML = emptyState(`Error loading products: ${res.error.message}`);
      return;
    }
    currentProducts = Array.isArray(res.data) ? res.data : [];
    // The currency profile resolves on a separate IPC round-trip; fetch it
    // before painting so the price columns are never rendered in the wrong
    // currency and then swapped underneath the cashier.
    profile = await loadStoreProfile();
    if (disposed || !tableEl.isConnected) return;
    countEl.textContent = `${currentProducts.length} product${currentProducts.length === 1 ? '' : 's'}`;
    tableEl.innerHTML = renderTable(currentProducts, profile);
  }

  async function refreshAll() {
    await Promise.all([refreshCategories(), refreshTable()]);
  }

  function openModal({ form, errors = {}, title }) {
    modalEl.innerHTML = `
      <div class="modal__backdrop" data-action="close"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__header">
          <h2>${escapeHtml(title)}</h2>
          <button class="btn btn--ghost" data-action="close" aria-label="Close">✕</button>
        </div>
        ${renderForm({ form, categories: currentCategories, errors, isEdit: Boolean(form.id) })}
      </div>`;
    modalEl.hidden = false;
    const firstInput = modalEl.querySelector('input[name="barcode"], input[name="name"]');
    if (firstInput) firstInput.focus();
  }

  function closeModal() {
    modalEl.hidden = true;
    modalEl.innerHTML = '';
  }

  function openForCreate() {
    openModal({ form: emptyForm(), title: 'Add product' });
  }

  async function openForEdit(id) {
    const res = await api().get(id);
    if (!res.ok || !res.data) {
      showToast(`Could not load product: ${res.error?.message || 'not found'}`, 'error');
      return;
    }
    openModal({ form: formFromProduct(res.data), title: `Edit ${res.data.name}` });
  }

  function confirmDelete(product) {
    modalEl.innerHTML = `
      <div class="modal__backdrop" data-action="close"></div>
      <div class="modal__panel" role="dialog" aria-modal="true">
        <div class="modal__header">
          <h2>Delete product?</h2>
          <button class="btn btn--ghost" data-action="close" aria-label="Close">✕</button>
        </div>
        <div class="modal__body">
          <p>This will permanently remove <strong>${escapeHtml(product.name)}</strong> (<code>${escapeHtml(product.sku)}</code>) from the catalogue.</p>
          <p class="muted">This action cannot be undone.</p>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="close">Cancel</button>
          <button type="button" class="btn btn--danger" data-action="confirm-delete" data-id="${product.id}">Delete</button>
        </div>
      </div>`;
    modalEl.hidden = false;
  }

  async function handleSubmit(formEl) {
    const input = readForm(formEl);
    const isEdit = Boolean(input.id);
    const res = isEdit ? await api().update(input) : await api().add(input);
    if (res.ok) {
      closeModal();
      showToast(isEdit ? 'Product updated.' : 'Product added.');
      await refreshAll();
      window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
      return;
    }
    const err = res.error || { message: 'Unknown error' };
    if (err.code === 'VALIDATION' && err.errors) {
      const form = isEdit ? formFromProduct({ ...input, id: Number(input.id) }) : input;
      openModal({ form, errors: err.errors, title: isEdit ? `Edit ${input.name || 'product'}` : 'Add product' });
      return;
    }
    if (err.code === 'DUPLICATE') {
      const form = isEdit ? formFromProduct({ ...input, id: Number(input.id) }) : input;
      const fieldErrors = { [err.field || 'barcode']: err.message };
      openModal({ form, errors: fieldErrors, title: isEdit ? `Edit ${input.name || 'product'}` : 'Add product' });
      return;
    }
    showToast(err.message || 'Could not save product.', 'error');
  }

  async function handleDelete(id) {
    const res = await api().delete(id);
    if (res.ok) {
      closeModal();
      showToast('Product deleted.');
      await refreshAll();
      window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
    } else {
      showToast(res.error?.message || 'Could not delete product.', 'error');
    }
  }

  async function handleSeed() {
    const res = await api().seedSample();
    if (res.ok) {
      // Guard the destructure: a malformed reply must surface a message,
      // not an uncaught TypeError inside this async handler.
      const { inserted = 0, skipped = 0, total = 0 } = res.data || {};
      if (inserted === 0) {
        showToast(`All ${total} sample products already loaded.`);
      } else {
        showToast(`Seeded ${inserted} sample product${inserted === 1 ? '' : 's'} (${skipped} already existed).`);
      }
      await refreshAll();
      window.dispatchEvent(new CustomEvent('quickbill:data-changed'));
    } else {
      showToast(res.error?.message || 'Could not seed sample products.', 'error');
    }
  }

  // ---- event wiring ----
  searchEl.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchTerm = searchEl.value;
      refreshTable();
    }, 120);
  });

  filterEl.addEventListener('change', () => {
    categoryFilter = filterEl.value;
    refreshTable();
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'new') return openForCreate();
    if (action === 'seed') return handleSeed();
    if (action === 'edit') return openForEdit(Number(btn.dataset.id));
    if (action === 'delete') {
      const id = Number(btn.dataset.id);
      const product = currentProducts.find(p => p.id === id);
      if (product) confirmDelete(product);
      return;
    }
    if (action === 'confirm-delete') return handleDelete(Number(btn.dataset.id));
    if (action === 'close') return closeModal();
  });

  modalEl.addEventListener('click', (e) => {
    // closest(), not matches(): a click that lands on a child of the close
    // affordance must still dismiss the modal.
    if (e.target.closest('[data-action="close"]')) closeModal();
  });

  modalEl.addEventListener('submit', (e) => {
    if (e.target.matches('.product-form')) {
      e.preventDefault();
      handleSubmit(e.target);
    }
  });

  function modalEscHandler(e) {
    if (e.key === 'Escape' && !modalEl.hidden) closeModal();
  }
  // Registered on `document`, so it must be released through the shell's
  // teardown contract — otherwise every visit to Products leaks another
  // live handler bound to a detached DOM tree.
  document.addEventListener('keydown', modalEscHandler);

  // First paint
  refreshAll();

  return {
    el: root,
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('keydown', modalEscHandler);
      clearTimeout(searchDebounce);
      clearTimeout(showToast._t);
    }
  };
}