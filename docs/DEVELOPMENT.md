# QuickBill — development notes

Reference documentation for QuickBill: the SQLite schema, the IPC
surface, the security model, the money-handling rules, the receipt
print pipeline, and a manual verification checklist for every phase.

For the project overview, setup steps and screenshots, see the
[README](../README.md).

## Feature history

- **Phase 1** — UI shell, sidebar navigation, dashboard with demo data.
- **Phase 2** — Persistent storage with SQLite, product management,
  inventory with low-stock highlighting.
- **Phase 3** — Point-of-sale checkout (preview): scan barcodes, search
  the catalogue, build a cart with discount and quantity controls, watch
  totals recompute in real time.
- **Phase 4** — Transactional checkout, sales ledger, stock deduction
  and a configurable GST rate.
- **Phase 5** — Receipts (re-printable from any sale), dashboards +
  sales history backed by the database, low-stock & inventory
  valuation reports, configurable store profile (name, address,
  currency, locale, receipt footer), printer integration via
  macOS's native print system.
- **Demo month** — One click on Sales History fills the ledger with
  30 days of realistic backdated invoices, so the dashboard,
  history and reports have something real to show.

## Tech

- Electron 31 with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`. The renderer cannot reach Node directly.
- **better-sqlite3** for the database. Synchronous, single-process, no
  extra worker thread. Rebuilt against Electron's Node ABI via
  `@electron/rebuild`.
- Vanilla ES modules in the renderer. No bundler. CSS uses design tokens
  declared in `src/styles/base.css`.

## File layout

```
main.js                Electron main process — window, menus, native dialogs, print
preload.js             contextBridge surface exposed as window.quickbill
src/
  index.html           App shell
  styles/              base.css (tokens), layout.css, components.css
  main/
    db.js              SQLite layer — schema, prepared statements, validation
    money.js           Currency math shared by the main process
    ipc.js             createIpcHandlers(): the channel -> handler registry
  scripts/
    app.js             SPA controller, mounts views, refreshes sidebar badge
    views/             One render() per top-level tab
    lib/
      money.js         Currency math (integer paise, no floats)
      cart.js          Cart state, totals breakdown, line items
      format.js        Intl-based currency / locale formatting
      receipt.js       buildReceiptDocuments(): in-app + printable HTML
      print.js         Printer list, print request, error-code to toast mapping
    data/demo-data.js  Static numbers used by the dashboard
tools/
  run-tests.js         Test launcher (re-execs each suite under Electron)
  test-*.js            Per-phase assertion suites
  smoke-ui-phase5.js   Headless UI smoke; captures screenshots
  screenshot.js        Screenshot helper for mockups/
```

## Running

```bash
npm install
npx electron-rebuild -f -w better-sqlite3     # already wired into install
npm start
```

`better-sqlite3` is a native module. After `npm install` you must run
`npx electron-rebuild` so the binary matches Electron's Node ABI (125 for
Electron 31). The `postinstall` hook in `package.json` does this automatically:

```bash
npm install --rebuild=better-sqlite3
```

If you ever see `NODE_MODULE_VERSION X` in the error output, run
`npx electron-rebuild` again.

## Where the database lives

The SQLite file is stored at:

- macOS   — `~/Library/Application Support/QuickBill/quickbill.sqlite`
- Linux   — `~/.config/QuickBill/quickbill.sqlite`
- Windows — `%APPDATA%\QuickBill\quickbill.sqlite`

(Path comes from `app.getPath('userData')`. When you run via
`npx electron .` in dev, the product name falls back to "Electron", so
the dev-time file is at `~/Library/Application Support/Electron/`.)

The packaged build uses the real app name. Either way the file lives
**outside** the packaged `.app` / `.asar`, so uninstalling the app does
not destroy catalogue data.

## Products table

```sql
CREATE TABLE products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode         TEXT    NOT NULL UNIQUE,
  sku             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT 'General',
  cost_price      REAL    NOT NULL DEFAULT 0 CHECK (cost_price      >= 0),
  selling_price   REAL    NOT NULL DEFAULT 0 CHECK (selling_price   >= 0),
  stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity  >= 0),
  min_stock_level INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_level >= 0),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Indexes on `category` and `name` keep search and filter snappy.

## Security model

Renderer code never talks to the filesystem or Node directly. Every
database call is funnelled through `ipcMain.handle('products:*')` in
`main.js`. The renderer-side API surface is exactly:

```js
window.quickbill = {
  app: { name, version, phase },
  products: {
    list(filters),           // { search, category }
    get(id),
    add(input),
    update(input),
    delete(id),
    categories(),
    lowStock(),
    countLowStock(),
    seedSample(),
    dbInfo()
  }
}
```

All handlers return `{ ok: true, data }` or
`{ ok: false, error: { code, message, field, errors } }`. Validation
errors carry a field-keyed `errors` map so the form can place them next
to the right input. SQL uses parameterised statements — never string
concatenation.

## Validation rules

| Field           | Rule                                            |
|-----------------|-------------------------------------------------|
| barcode, sku    | required, trimmed                               |
| name            | required, trimmed                               |
| cost_price      | required, finite, ≥ 0                           |
| selling_price   | required, finite, ≥ 0, ≥ cost_price             |
| stock_quantity  | required, integer, ≥ 0                          |
| min_stock_level | required, integer, ≥ 0                          |
| barcode / sku   | unique across the table (UNIQUE constraint)     |

On insert or update, an invalid row throws `{ code: 'VALIDATION', errors }`;
a duplicate barcode or SKU throws `{ code: 'DUPLICATE', field }`.

## Sample data

The Products screen has an **Add sample products** button that calls
`seedSampleProducts()`. It inserts 15 stable rows — covering
Beverages, Dairy, Bakery, Snacks, Produce, Grocery, Frozen, Personal
Care, and Household categories. The seeder is **idempotent**: it looks
up each sample's barcode first and only inserts the ones that aren't
already in the table, so clicking the button repeatedly never produces
duplicates.

## Demo month of sales

Sales History has a **Load demo month** button. It books **30 days**
of backdated invoices ending today, so a fresh install has a populated
Sales History, Dashboard and Reports instead of empty screens.

### How it works

Every demo invoice is created through the **same `createSale()`
checkout path the till uses** — same price lookup, same tax maths,
same stock decrement, same bill numbering, same idempotency table.
Nothing is written behind `createSale`'s back, so a demo ledger is
indistinguishable from a real one: every report, receipt and reprint
reads it through exactly the same code.

The realism comes from the plan, not from post-processing:

| Aspect | Behaviour |
|--------|-----------|
| Volume | Busier at weekends, quieter midweek, bounded jitter |
| Baskets | 1–5 lines, weighted so cheap staples turn over faster than expensive ones |
| Quantities | Mostly 1–2, occasionally a bulk buy |
| Discounts | None on most bills; a flat ₹5/₹10/₹20 on some, capped at a quarter of the basket |
| Tax | The store's configured rate, so demo receipts agree with Settings |
| Payment | Cash (exact or tendered as the next round note up), some part-paid, a few on credit |
| Timestamps | Spread across trading hours 08:00–21:00; today's invoices are compressed into the hours that have actually elapsed |

Today is deliberately special. Its invoice count scales with the
trading day elapsed, so seeding at 09:00 books a morning's worth and
clicking again at 17:00 **tops the day up** — the morning's existing
invoices are replayed through the idempotency check and left exactly
as they were, never rewritten. Past days are complete the moment they
are written.

### Two properties worth knowing

**It is idempotent.** Each invoice carries
`clientRequestId = demo-<YYYY-MM-DD>-<n>`, so re-running replays
instead of duplicating. Which days are already filled is read back
from the `idempotency` table — the ledger itself is the record, so a
restored backup or a partially-completed run can never cause a
double-booked day. Clicking again after new days pass fills only the
new ones.

**It tops up stock first.** A month of trading drains a 15-item
catalogue many times over. Before booking anything, the seeder raises
each product's stock to cover the demand it is about to generate, plus
the reorder level and a little headroom. Without this, seeding fails
with `INSUFFICIENT_STOCK` a few days in. The uplift is reported back
as `restocked` — demo data never silently edits inventory.

The whole month is written in **one transaction**: if anything fails,
you get none of it rather than a half-seeded ledger.

### Backdating is main-process-only

`createSale()` takes the timestamp as a **second argument**
`createSale(input, { createdAt })`, not in the payload. Nothing
coming through IPC can reach it, so a real checkout can never be
stamped into the past. The value is also required to be an **own**
property carrying a real `Date`, so a prototype-inherited or
non-Date `createdAt` is ignored rather than honoured. The
renderer-facing call signature is unchanged:

```js
sales: {
  create, get, getByBill, list, todaySummary,
  seedDemo({ days })   // 1..90, defaults to 30
}
```

Bill numbers follow the day they were rung up on: an invoice dated the
3rd reads `INV-20261003-####`, not today's date with a historical
timestamp.

### Clearing it

There is no delete-sale API (the ledger is append-only by design), so
to start clean either restore a backup via **Settings → Restore**, or
delete `quickbill.sqlite` and let the app recreate it.

## Verification (what to test)

1. **Launch**
   ```bash
   npm start
   ```
   The app should open to the Dashboard with the Phase 1 demo layout,
   and the sidebar footer should now read "Phase 2".

2. **Seed sample data**
   - Click **Products** in the sidebar.
   - Click **Add sample products**. A toast confirms how many were
     inserted (15 on a fresh DB; 0 thereafter).
   - The Inventory sidebar badge should change to **3** (the seeded
     items that are at or below their reorder level).

3. **Add product**
   - Click **+ Add product**.
   - Try saving with empty fields → form shows "Required" next to every
     missing input.
   - Try `cost_price = 5`, `selling_price = 2` → "Selling price must
     be ≥ cost price".
   - Try `stock_quantity = -1` → "Cannot be negative".
   - Fill in everything, save → toast, table refreshes.

5. **Search and filter**
   - Type in the toolbar search box. The table should narrow to rows
     whose name, SKU or barcode contains the substring (case-insensitive,
     with debounce).
   - Pick a category from the dropdown. The list narrows to that
     category only.

6. **Edit**
   - Click **Edit** on any row. The modal opens pre-populated.
   - Change a field and save → table reflects the change, toast confirms.

7. **Delete**
   - Click **Delete** → confirmation modal → Delete. Toast confirms.

8. **Duplicate barcode**
   - Add a new product reusing any existing barcode. The save fails
     inline: "Barcode `<value>` is already in use." stays next to the
     barcode field.

9. **Low-stock highlighting**
   - Open the **Inventory** view. Rows where stock ≤ reorder level have a
     red left border and a "Reorder now" pill. The "Low-stock only" tab
     filters to just those rows.

10. **Persistence**
    - Quit the app (Cmd+Q on macOS, close the window on Windows/Linux).
    - Run `npm start` again.
    - Open **Products** — every row you added or seeded is still there.
    - The Inventory badge still reflects the current low-stock count.

11. **Headless smoke test**
    A scripted end-to-end check of the database layer lives in the
    repository history. It exercises every CRUD path, validation
    branch, duplicate detection, and a fresh reopen of the DB to prove
    persistence. You can rerun any single test by calling the matching
    function from `src/main/db.js` directly inside `npx electron` mode.

## Phase 3 — POS checkout (preview)

Open the Billing view and the checkout workspace fills two columns: a
capture area on the left, the live invoice on the right.

### Capture column

- **Scan barcode / SKU** — a single-line input that accepts USB
  barcode-scanner input (scanners type the code and finish with
  `Enter`). The handler looks the value up in the in-memory catalogue
  cache; a hit adds the product to the cart and clears the input, a
  miss shows an inline red banner with the rejected code and a brief
  shake animation.
- **Search catalogue** — debounced live search against the products
  table. Click **+ Add** on any result row to push it into the cart.
  Press **F4** to focus the search box, **Esc** to clear and refocus
  the scanner.

### Invoice column

- A header chip shows the running **item count**. The empty state
  guides the cashier to scan or search.
- Each line shows name + SKU + barcode, unit price, a quantity stepper
  (`−` button, integer input, `+` button), line total, and a remove
  button. Typing a non-integer, zero, negative, or > 9999 value is
  rejected inline with an "At least 1" / "Whole numbers only" message
  and a red border; the cart is only mutated on a valid value.
- Below the cart: **Discount (₹)** (flat paise off the subtotal, capped
  at the subtotal) and **Tax (%)** (applied to the post-discount
  amount). Both inputs validate on blur / Enter.
- The totals block shows: **Items**, **Subtotal**, **Discount**,
  **Tax (X.XX%)**, and a large **Total payable** in rupees.
- **Clear cart** asks for confirmation if the cart isn't empty, then
  resets quantities, discount, tax, and the form inputs.

### Currency safety

Every monetary value inside the cart lives as an **integer count of
paise** (1 INR = 100 paise). All additions, subtractions, percentage
calculations and the DB-stored price import go through
`src/scripts/lib/money.js`. No floats anywhere on the cart side — the
`fromRupees` boundary rounds once when a price is loaded into the cart
and everything downstream is integer arithmetic. Discounts cap at the
subtotal; tax uses half-to-even at the rounding boundary.

### Indian rupees

Totals and per-line prices are formatted with `Intl.NumberFormat` for
`en-IN`, producing `₹1,23,456.78` style grouping.

### Security

The billing view never talks to Node or the filesystem directly. All
catalogue reads go through `window.quickbill.products` — the same
contextBridge surface used by the Products view. The scan input
consumes scanner keystrokes inside the renderer; the cart lives in
renderer memory; nothing is sent to the main process from the billing view
in Phase 3.

### Keyboard map

| Key     | Action                                          |
|---------|-------------------------------------------------|
| `F2`    | Focus the scan input                            |
| `F4`    | Focus the search input                          |
| `Esc`   | In search: clear + refocus scan. In scan: clear.|
| `Enter` | In scan: commit the scanned code. In search:    |
|         | no-op (search is live). In qty/disc/tax: commit.|
| `↑`/`↓` | (Phase 4)   |

### Verification (what to test)

1. **Seed sample data** (Products → **Add sample products**) so the
   catalogue has 15 rows to scan.
2. **Billing → scan** — type `8901030865278` and press Enter. The cart
   should grow by one row, the success banner should read "Added
   Sparkling Water 1L", and the totals block should update to
   `Subtotal ₹1.20 / Total payable ₹1.20`.
3. **Billing → search** — type `milk`, click **+ Add** on the result.
   The cart should now have two rows; item count reads `2`.
4. **Increment / decrement** — click `+` on a row to bump quantity, `−`
   to drop it (floor at 1). Click ✕ to remove the row entirely.
5. **Direct edit** — click into a row's qty input, type `5`, press
   Enter or click outside. The line total and grand total should
   recompute. Try typing `0` — the input gets a red border and "At
   least 1" appears under it; the cart is unchanged.
6. **Decimal quantity** — type `1.5` and blur. Inline error: "Whole
   numbers only".
7. **Discount / tax** — set Discount to `5` and Tax to `5`. Subtotal
   drops by ₹5, tax is 5 % of the remainder.
8. **Unknown barcode** — type `0000000000000` and press Enter. The
   scan input flashes red and an "Unknown barcode: …" banner appears;
   the cart is unchanged.
10. **Clear cart** — with items in the cart, click **Clear cart**.
    Confirm the prompt; the invoice returns to the empty state and
    item count goes back to `0`.
11. **Currency safety** — `₹0.10` + `₹0.20` + tax 5% produces exactly
    `₹0.31` (or ₹0.32 depending on banker's rounding at the half-paise
    boundary), never `₹0.30000000000000004`.

### Phase 4 preview

The "Complete sale (preview)" button is intentionally disabled. Phase 4
will: persist each completed sale to the DB, decrement stock on the
sold products, render the printable receipt, and unlock the button.

## Phase 4 — Sales ledger & transactional checkout

Phase 4 wires the Billing view to a persistent sales ledger. Every
checkout now resolves prices, stock and totals authoritatively inside
the main process, and persists the result, the line items and the
stock decrement inside a single SQLite transaction. Bill numbers are
unique, payments are recorded as paid / partial / unpaid, and the cart
is only cleared after the transaction succeeds.

### New tables

```sql
-- Sales: one row per invoice. Money is integer paise.
CREATE TABLE sales (
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
  cashier_name           TEXT    NOT NULL DEFAULT '',
  customer_name          TEXT    NOT NULL DEFAULT '',
  notes                  TEXT    NOT NULL DEFAULT '',
  created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE INDEX idx_sales_bill       ON sales(bill_number);

-- One row per line item. ON DELETE CASCADE keeps bills readable;
-- ON DELETE RESTRICT for product_id prevents historical records
-- being orphaned when a product is removed.
CREATE TABLE sale_items (
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
CREATE INDEX idx_sale_items_sale_id    ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product_id ON sale_items(product_id);

-- Flat key/value table for non-product configuration. Currently used
-- only for `tax_percent`; future-proofed for store address, receipt
-- header, etc.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Idempotency — protects against accidental double-billing when the
-- renderer retries the same `clientRequestId`.
CREATE TABLE idempotency (
  client_request_id TEXT PRIMARY KEY,
  sale_id           INTEGER NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### Authoritative checkout

The renderer sends only the cart shape and the payment intent:

```js
window.quickbill.sales.create({
  clientRequestId: 'cashier-A-…',
  items: [{ barcode: '8901030865278', quantity: 2 }],
  discountPaise: 100,           // already in paise (integer)
  taxPercent:    5,
  payment:       { method: 'cash', amountReceivedPaise: 500 }
});
```

The main process:

1. Validates every field (`VALIDATION` errors include field-level hints).
2. Re-reads each product from inside the open transaction — never
   trusting prices or stock the renderer claims.
3. Rejects with `PRODUCT_MISSING` if the barcode disappeared, or
   `INSUFFICIENT_STOCK` if the requested quantity isn't available.
4. Computes subtotal, capped discount, tax (half-to-even rounding) and
   the total. Derives `payment_status` (`paid` / `partial` / `unpaid`)
   and `change_due_paise` from the amount actually received.
5. Generates a unique bill number of the form `INV-YYYYMMDD-####`,
   retrying on collision (the `UNIQUE` constraint is the safety net).
6. Decrements `products.stock_quantity` with a guarded UPDATE
   (`WHERE stock_quantity >= :qty`) so a race still produces a clean
   `INSUFFICIENT_STOCK` rather than a negative stock count.
7. Inserts the `sales` row, all `sale_items` rows, and (if a
   `clientRequestId` was provided) the `idempotency` row. If anything
   throws, the entire transaction rolls back — no half-baked sales,
   no half-deducted stock.

### Idempotency

If the renderer retries a checkout with the same `clientRequestId`
(network glitch, double-click), the existing sale is returned with
`replayed: true` and no extra rows are inserted. Stock is decremented
exactly once.

### Sales history

The Sales History screen is real now. Use the **from** / **to** date
inputs to scope the list (defaulting to today), and the search field to
filter by bill number, cashier or customer. Click any row to open the
full bill detail with line items, totals and the recorded payment.

### Settings → Tax rate

The Settings view exposes a single field — the default tax rate (%).
The value is stored in the `settings` table and used both by the
billing view (to pre-fill the input) and by the main process at
checkout (where it is applied authoritatively to the post-discount
subtotal).

> **Tax configuration notice.** QuickBill does not invent applicable
> GST/VAT rules. The operator is responsible for entering a percentage
> that has been verified for their jurisdiction. The application of tax
> is intentionally a single flat percent on the post-discount subtotal;
> place-of-supply rules, slab-based GST, reverse charge, and exemptions
> are out of scope for this build.

### Renderer-side checkout safety

- The renderer never sends `unit_price_paise` or `stock_quantity`
  alongside the cart. Those are always derived by the main process.
- A single-flight flag (`checkoutInFlight`) plus a disabled
  **Complete sale** button prevent double submission from rapid clicks
  or `F9` repeats.
- The receipt modal stays on screen until the cashier closes it; the
  cart is reset only when the modal closes (and, for the deliberate
  "New sale" action, by the close-and-clear shortcut).
- Errors are surfaced as red banners plus a toast with a copy-pasteable
  message: `INSUFFICIENT_STOCK`, `PRODUCT_MISSING`, `VALIDATION`,
  `BILL_NUMBER_COLLISION`, or a generic DB error.

### Verification (what to test)

1. **Seed catalogue.** Open Products → **Add sample products** so the
   catalogue and stock counts are populated. The Inventory badge should
   show three low-stock items.
2. **Configure tax (optional).** Open Settings → set tax to e.g. `5%`,
   press **Save tax rate**.
3. **Happy path sale.** Billing → scan `8901030865278` (Sparkling
   Water), press Enter twice. The cart gains one row, totals show
   `Subtotal ₹1.20`. Set **Amount received** to `5`, click **Complete
   sale**. A receipt modal opens with bill number
   `INV-YYYYMMDD-0001`, status `Paid`, `Change due ₹3.80`.
4. **Receipt surfaces authoritative numbers.** Drill into a row of
   the sale in the database (e.g. open the SQLite file with the CLI):
   `unit_price_paise` is `120`, `total_paise` is `120`, `change_due_paise`
   is `380`.
5. **Stock deduction.** Re-open Inventory and confirm the sparkling
   water row dropped by one. Low-stock badge unchanged if it wasn't
   already low.
6. **Sales history.** Open Sales History. The new bill should be at
   the top of the list, status `Paid`. Click the row to open the bill
   detail modal.
7. **Date filter.** Change **From** / **To** to a previous day — the
   list empties. Set them back to today — the sale reappears.
8. **Bill search.** Type the trailing digits of the bill number into
   the search box; the row narrows.
9. **Insufficient stock.** Force a failure: edit `Whole Milk 1L` (3 in
   stock) to `stock_quantity = 1` from the Products screen, scan it
   four times. **Complete sale** is rejected with a red banner showing
   "Insufficient stock for …"; no sale is recorded; the database row
   has no orphaned `sales` or `sale_items` rows.
10. **Product removed.** Delete a product that's still in the cart,
    then click **Complete sale**. The checkout errors with
    `PRODUCT_MISSING`; nothing is persisted.
11. **Unpaid sale.** Tick **Unpaid (credit)** as the payment method,
    set tax to `5`, scan a product. After checkout the receipt shows
    status `Unpaid` instead of `Paid`, and the database
    `payment_status = 'unpaid'`, `amount_received_paise = 0`.
12. **Double-submit guard.** From the OS terminal, run the smoke test:
    ```bash
    npm test
    ```
    It exercises idempotency, insufficient stock rollback, bill-number
    uniqueness, payment status derivation and tax round-trips against a
    fresh in-memory database, plus the Phase 5 dashboard / settings /
    reports suite. All 102 assertions must pass (48 in phase 4, 54 in phase 5).
13. **Currency safety.** ₹1.20 × 3 + 5 % tax produces exactly
    `₹3.78` (360 paise + 18 paise tax = 378 paise), never
    `₹3.7999999…`.
14. **Renderer cannot forge prices.** Add a `unit_price_paise` field
    to the test payload if you're hand-instrumenting from devtools —
    the main process ignores it. Only `selling_price` in the products
    table is used.

## Phase 5 — Receipts, reports & application settings

Phase 5 turns the dashboard, sales history, reports and receipts from
placeholders / static demos into live, database-backed screens. Every
figure shown in Phase 5 is read straight from the persistent ledger
that Phases 2–4 put in place; nothing is regenerated on the fly, and
historical sale records are append-only.

### What's new

| Area         | Behaviour                                                              |
|--------------|------------------------------------------------------------------------|
| Receipts     | Generated for every completed sale. Re-printable from Sales History.  |
| Printing     | Uses macOS's native print dialog via `webContents.print()`.           |
| Dashboard    | Live: today's + range sales, bill count, avg ticket, tax, low-stock. |
| Reports      | Sales summary, low-stock, inventory valuation (cost & retail), by-category breakdown. |
| Settings     | Full store profile: name, address, phone, GSTIN, currency, locale, receipt footer, tax label & percent. |
| Validation   | Every setting field is validated centrally; bad values are rejected with field-keyed errors. |
| Persistence  | Settings survive app restart; verified via `npm test`.               |

### Receipt contents

Every receipt — printed and in-app — carries:

- **Store name, address, phone, email, GSTIN** (from the configured profile)
- **Bill number** (`INV-YYYYMMDD-####`)
- **Date and time** (the bill's `created_at`)
- **Line items** with name, SKU, quantity, unit price, line total
- **Subtotal**, **Discount** (if any), **Tax** (with the configured tax label and percent), **Total**
- **Payment method, status, amount received, change due** (where applicable)
- **Receipt footer** (configurable)
- **Currency + locale** tag so the cashier knows which grouping produced the numbers

The in-app receipt (Billing modal, Sales History detail) and the
printable HTML sent to the OS are produced by **the same renderer** —
`src/scripts/lib/receipt.js` exports `buildReceiptDocuments(...)`
which yields both an in-app fragment (`renderReceiptInnerHtml`) and a
print-friendly document (`buildPrintableReceiptHtml`). They agree
byte-for-byte on the data, currency, and labels; only the wrapping
chrome differs.

### Print pipeline

`main.js` registers a small IPC bridge for printing:

```
renderer (Billing modal / Sales History modal)
   ↓ window.quickbill.receipt.print({ html, printer, copies })
main process
   ↓ webContents.getPrintersAsync()
   ↓ new BrowserWindow({ show: false }) + loadURL(data:text/html;...)
   ↓ webContents.print({ silent: false, ... })
   ↓ callback(success, failureReason)
renderer (toast / banner)
```

Failure modes are surfaced with explicit codes so the cashier knows
why a print didn't go through:

| Code                  | Trigger                                            | Message                                                         |
|-----------------------|----------------------------------------------------|-----------------------------------------------------------------|
| `NO_PRINTER`          | `getPrintersAsync()` returned an empty list        | "No printer is configured on this Mac. Add one in System Settings → Printers & Scanners." |
| `PRINTER_CANCELLED`   | User dismissed the print dialog                    | "Printing was cancelled." (treated as soft info, not error)    |
| `PRINTER_FAILED`      | The OS reported a generic failure                  | "The system printer reported an error: <reason>."               |
| `VALIDATION`          | Renderer sent empty / non-string HTML              | "Print request is missing receipt HTML."                        |

The renderer maps each code to a toast (successes, cancellation) or a
red banner (failures), so the cashier can read it from across the
counter.

#### Setting up a printer on macOS

QuickBill prints through macOS's CUPS-backed print system. The app
itself doesn't need any extra configuration; what matters is that the
Mac has at least one printer the OS knows about. To install one:

1. Open **System Settings → Printers & Scanners** (or run the older
   **System Preferences → Printers & Scanners** on older macOS).
2. Click **Add printer, scanner or fax…**.
3. macOS auto-discovers AirPrint, IPP, LPD, and SMB printers on the
   local network. Pick one and click **Add**. For a USB-connected
   thermal receipt printer, plug it in first; macOS will usually
   install a generic driver and add it to the list automatically. If
   the manufacturer ships a PPD / driver, install that first.
4. Confirm the printer shows up in the list with a green status dot.

For development without real hardware, macOS ships a **PDF** virtual
printer. It's always present and shows up under "Save as PDF" in the
print dialog — use it to verify the receipt layout before rolling out
to a real receipt printer:

1. Click **Print receipt** in Billing or Sales History.
2. In the system print dialog, choose **PDF → Save as PDF** in the
   bottom-left dropdown.
3. Pick a path; open the PDF and confirm the receipt matches the
   in-app version.

If the print dialog lists no printers at all, `getPrintersAsync()`
returns an empty array, QuickBill surfaces the `NO_PRINTER` error, and
the cashier sees a banner explaining how to add one. This is the
expected behaviour when the app is launched for the first time on a
fresh Mac.

### Sales dashboard

The dashboard view is now driven by a single `reports:dashboard` IPC
handler that aggregates:

- Today's + range **sales totals**, **bill count**, **average ticket**
- **Tax collected** (today, with range subtotal for context)
- **Low-stock** count + units in stock
- A **daily sales trend** (line chart, trailing 14 days by default)
- **Best-selling products** (bar chart, top 8 by quantity)
- **Recent transactions** table (last 8 invoices in range)
- A "Historical integrity" card reminding the cashier that completed
  sales are append-only — there is no silent edit affordance anywhere.

Date pickers default to today; change them and click **Refresh** to
inspect any window. The view also re-freshes itself whenever a
checkout completes (the renderer dispatches `quickbill:data-changed`)
or the store profile changes (`quickbill:settings-updated`).

#### Daily trend semantics

The trend card is a **trailing window ending at the range's end date**,
not a filter-scoped read — the stat tiles beside it are the range-scoped
ones. Three properties are load-bearing, because the chart is a line
over calendar days:

- The series is **dense**: exactly one point per calendar day, oldest
  first. Days with no sales are present as zeroes rather than omitted,
  so the x-axis is uniform in time and a quiet week reads as a dip
  instead of silently compressing the scale.
- The window is **anchored to the end**, `limit` days back (14 by
  default). Anchoring is why the default today→today range still draws
  a two-week chart: clamping to `from` collapsed it to a single point,
  and a one-point line has nothing to draw between its ends.
- The card **labels the days it actually plots** (range, day count and
  total) so a trailing window is never presented as if it were the
  filter range.

`getSalesDailyTrend()` honours an explicit `to` for historical windows,
returns an all-zero but still dense series for a sales-free window, and
returns `[]` for an inverted range.

### Reports

Open **Reports** for:

- **Sales summary** — counts, totals, paid/partial/unpaid, cash
  received, change issued, avg ticket, first/last sale times.
- **Low-stock report** — items at or below their reorder level,
  highlighted the same way as the inventory tab.
- **Inventory valuation** — total units, total cost value, total
  retail value, # of low-stock items, plus a per-category breakdown
  showing where the value sits.
- All currency formatting follows the configured store profile.

Every panel shows loading spinners on first paint, an empty state when
there's no data, and an error banner if the IPC round-trip fails.

### Sales History — Reopen and Reprint

The Sales History list is unchanged from Phase 4 but the bill-detail
modal now mirrors the Billing receipt modal:

- Click any row → modal opens with the receipt body
- **Print receipt** — opens the system print dialog (pre-selects the
  chosen printer if one was picked)
- **Close** — dismisses the modal
- **Default printer** dropdown — populated from the OS's installed
  printers (read via `webContents.getPrintersAsync()`); disabled
  automatically when no printers are detected

The renderer never mutates the underlying sale. Reopens and reprints
always show the **persisted** values, including line totals, payment
status, change due and cashier name — exactly what was on the printed
receipt the first time around.

### Application settings

Settings → Store profile now exposes every persisted field:

| Field            | Required | Validation                                       |
|------------------|----------|--------------------------------------------------|
| Store name       | ✓        | 1..120 chars, trimmed                            |
| Address          |          | ≤ 240 chars                                      |
| Phone            |          | ≤ 40 chars                                       |
| Email            |          | ≤ 120 chars                                      |
| GSTIN            |          | ≤ 32 chars                                       |
| Currency code    | ✓        | ISO 4217 (`/^[A-Z]{3}$/`)                        |
| Currency symbol  | ✓        | ≤ 4 chars                                        |
| Locale           | ✓        | BCP-47 (`/^[a-z]{2}(-[A-Z]{2})?$/`)              |
| Tax label        | ✓        | ≤ 32 chars                                       |
| Invoice prefix   | ✓        | `/^[A-Z0-9_-]+$/`                                |
| Receipt footer   |          | ≤ 240 chars                                      |
| Tax percent      |          | 0..1000, finite                                  |

Errors are mapped field-by-field next to the input. **Save settings**
runs a single SQLite transaction; an interruption never leaves the
profile half-saved. The Settings view also includes a **Receipt
preview** card on the right showing the formatted currency so the
operator can see the impact immediately, and a **Hardware &
devices** card listing every installed printer.

### Historical integrity

Sales rows and `sale_items` rows are append-only. The `sales` and
`sale_items` tables intentionally expose **no UPDATE path** —
`createSale` (Phase 4) is the only writer. Deleting a `products` row
that has been sold throws (`ON DELETE RESTRICT`), preventing
historical records from being silently orphaned. The Phase 5 test
suite asserts the absence of any sale-edit API and the FK behaviour.

Note that the demo seeder does **not** bypass this. It books through
`createSale()` like any other checkout; the only thing it adds is a
`createdAt` supplied by the main process, which is why seeding can
produce backdated history without weakening the append-only rule.

### Security model updates

The preload's `window.quickbill.*` surface now exposes:

```js
settings: {
  getStore,         // { storeName, storeAddress, currencyCode, taxPercent, ... }
  setStoreProfile,  // partial update, validated server-side, transactional
  profileFields,    // description table for the renderer form
  setTaxPercent
},
receipt: {
  forSale(id),      // returns { store, sale, items } for the modal / print doc
  printers(),       // returns the OS's installed printers
  print({ html, printer, copies })
},
reports: {
  dashboard(filters), // single round-trip for the dashboard tiles
  salesSummary, bestSellers, inventoryValuation, lowStock
},
sales: {
  seedDemo({ days })  // books backdated demo invoices; `days` is 1..90
}
```

Every handler still returns `{ ok: true, data } | { ok: false, error }`;
no Node APIs leak into the renderer. Print happens entirely in the
main process; the renderer only sends HTML + printer name. The print
HTML is loaded into a hidden `BrowserWindow` with the same secure
defaults (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`).

### Phase 5 verification

```bash
npm test
```

This runs all phases under Electron's Node runtime (the `better-sqlite3`
binary is built against Electron's Node ABI, so plain system Node
cannot load it). The runner wraps `electron` with
`ELECTRON_RUN_AS_NODE=1` and invokes the test files in order:

- `tools/test-phase4-sales.js` — 48 assertions (checkout, idempotency,
  bill uniqueness, payment status, tax round-trip, sales history)
- `tools/test-phase5-reports.js` — 69 assertions (store profile
  defaults, validation, persistence across reopen, receipt profile,
  sales summary math, best sellers aggregation, inventory valuation,
  recent sales, historical integrity)
- `tools/test-demo-sales.js` — 65 assertions (day coverage, invoice
  realism, bill-number dating, report reconciliation, stock safety,
  timestamp spread, idempotency, partial windows, free-priced products,
  backdating guards, append-only invariant)

Expected output:

```
48 passed, 0 failed
✓ phase4 passed
…
69 passed, 0 failed
✓ phase5 passed
…
65 passed, 0 failed
✓ demo passed
All requested test phases passed.
```

Run a single phase with:

```bash
npm run test:phase4
npm run test:phase5
npm run test:demo
```

A headless UI smoke that boots Electron, mounts every view, and
captures screenshots to `tools/.smoke-phase5/` is also available:

```bash
./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  tools/smoke-ui-phase5.js
```

It exits 0 only when all 55 checks pass.

## macOS printer setup — checklist

Use this when installing QuickBill on a new machine.

- [ ] Confirm at least one printer is visible in **System Settings →
      Printers & Scanners**.
- [ ] If you're testing without a real printer, macOS's built-in
      **PDF** printer is enough — pick **PDF → Save as PDF** in the
      print dialog to verify the receipt layout.
- [ ] Launch QuickBill, open **Settings → Hardware & devices**, and
      confirm the same printers show up there.
- [ ] Complete a sale in **Billing**, click **Print receipt**, and
      confirm the system print dialog opens with the receipt
      formatted for the chosen roll / paper size.
- [ ] Reopen the same sale from **Sales History**, click
      **Reopen → Print receipt**, and confirm the reprint matches the
      values from the original checkout.

If anything is missing — printer list is empty, dialog doesn't open,
or the receipt gets garbled — check:

- The Mac's print spooler isn't paused (System Settings → Printers →
  right-click → Resume printing).
- For thermal / receipt printers: install the manufacturer's driver
  before adding the printer.
- Restart the app so Electron re-runs `getPrintersAsync()`.

## Phase 1 features preserved

- Sidebar navigation, topbar, and shell layout are unchanged.
- All Phase 1 view files were replaced in Phases 2–5 with the real
  implementations: `products.js`, `inventory.js`, `billing.js`,
  `sales-history.js`, `settings.js`, `dashboard.js`, `reports.js`.
- Settings → About this build card was retired in Phase 5; the same
  system defaults are now documented under "Phase 5 verification" and
  the macOS printer setup checklist.