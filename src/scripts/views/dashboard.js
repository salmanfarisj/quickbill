// QuickBill — Dashboard view, Phase 5.
//
// Reads live data from the main process. Demo numbers from earlier
// phases are gone; every card, list, chart and trend line comes from
// the persistent sales ledger and products table via contextBridge.
//
// Loading / empty / error states are visible on first paint and any
// refresh. The renderer dispatches `quickbill:data-changed` whenever
// the user commits a sale, so the dashboard refreshes itself as soon
// as it's safe to re-query (debounced).

import {
  formatCurrency, formatCurrencyValue, fromPaise
} from '../lib/money.js';
import { statusLabel, statusClass, saleTimestamp } from '../lib/format.js';

const reportsApi = () => window.quickbill?.reports;
const settingsApi = () => window.quickbill?.settings;

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function stat({ label, value, sub, kind = 'flat', loading = false, errorText = '' }) {
  const el = document.createElement('div');
  el.className = 'stat';
  const dirClass =
    kind === 'up'    ? 'stat__delta--up'    :
    kind === 'down'  ? 'stat__delta--down'  : 'stat__delta--flat';
  el.innerHTML = `
    <div class="stat__label">${escapeHtml(label)}</div>
    <div class="stat__value">${loading ? '<span class="stat__skeleton">&nbsp;</span>' : escapeHtml(value)}</div>
    <div class="stat__delta ${errorText ? 'stat__delta--down' : dirClass}">
      ${errorText ? escapeHtml(errorText) : escapeHtml(sub || '')}
    </div>`;
  return el;
}

function emptyState(message, kind = 'soft') {
  return `<div class="pos-empty pos-empty--${kind}">${escapeHtml(message)}</div>`;
}

function loadingState(message = 'Loading…') {
  return `<div class="card__body" style="text-align:center; color: var(--muted); padding: 36px 18px;">${escapeHtml(message)}</div>`;
}

function errorState(message) {
  return `<div class="card__body" style="text-align:center; color: var(--error); padding: 24px 18px;">${escapeHtml(message || 'Something went wrong.')}</div>`;
}

// ---------------------------------------------------------------------------
// SVG helpers — small enough to keep inline; no third-party chart deps.
// ---------------------------------------------------------------------------

// `points` arrives dense from getSalesDailyTrend (one per calendar day, oldest
// first), so the x-axis is uniform in time and `i` maps straight to a day.
//
// Two renderer bugs this shape fixes:
//   * ONE point drew `M x,y` and nothing else — no line, no area — so the
//     chart read as an empty box. A single day now centres itself and draws a
//     full-width bar, which is what "one day of sales" should look like.
//   * `preserveAspectRatio="none"` stretched the viewBox to the container,
//     smearing the dots and text horizontally. The chart is now drawn at the
//     card's real pixel width, so nothing distorts and labels stay legible.
function trendSvg(points, width = 600, height = 180, format = formatCurrency) {
  if (!points.length) return emptyState('No sales yet — complete a sale to see the trend.');

  const fmt = typeof format === 'function' ? format : formatCurrency;
  // Room on the left for the y-axis money labels, which the chart did not have
  // before — the old axis was unlabelled, so the height of a peak was
  // unreadable.
  const pad = { l: 62, r: 14, t: 16, b: 26 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = Math.max(10, height - pad.t - pad.b);

  const peak = Math.max(...points.map(p => p.totalPaise));
  const max = peak > 0 ? peak : 1;
  const floorY = pad.t + innerH;

  // A single day has no slope to draw: give it a centred, full-height bar so
  // the card shows its value instead of an empty plot area.
  const single = points.length === 1;
  const barW = single ? Math.min(120, innerW * 0.5) : 0;
  const xOf = (i) => single
    ? pad.l + innerW / 2
    : pad.l + (innerW * i) / (points.length - 1);

  const pointsXY = points.map((p, i) => ({
    x: xOf(i),
    y: pad.t + innerH - (p.totalPaise / max) * innerH,
    ...p
  }));

  const line = pointsXY.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = single ? '' : line +
    ` L${pointsXY[pointsXY.length - 1].x.toFixed(1)},${floorY.toFixed(1)}` +
    ` L${pointsXY[0].x.toFixed(1)},${floorY.toFixed(1)} Z`;

  // Round the axis up to a friendly ceiling so gridlines land on readable
  // money values (₹100 / ₹250 / ₹1,000) instead of an arbitrary peak.
  // An all-zero window has no peak to scale to — `Math.log10(0)` is -Infinity
  // and produced a degenerate axis reading "₹0.01" — so that case is drawn
  // unlabelled, with the flat note carrying the message instead.
  const hasSales = peak > 0;
  const magnitude = hasSales ? Math.pow(10, Math.floor(Math.log10(max))) : 1;
  const ceiling = hasSales ? Math.ceil(max / magnitude) * magnitude : 1;
  const scale = ceiling > 0 ? ceiling : 1;

  const gridlines = [0, 0.5, 1].map(frac => {
    const y = floorY - frac * innerH;
    return `
      <line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + innerW).toFixed(1)}" y2="${y.toFixed(1)}"
            stroke="var(--border)" stroke-width="1" />
      ${hasSales ? `<text x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="var(--muted)"
            font-size="10">${escapeHtml(fmt(Math.round(scale * frac)))}</text>` : ''}`;
  }).join('');

  // Label the first and last day plus a few between, never more than the
  // chart can fit without collisions.
  const maxLabels = Math.max(2, Math.min(points.length, Math.floor(innerW / 58)));
  const stride = Math.max(1, Math.ceil(points.length / maxLabels));
  const ticks = pointsXY
    .filter((_, i) => i % stride === 0 || i === pointsXY.length - 1)
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="10">${escapeHtml(p.day.slice(5))}</text>`)
    .join('');

  // Keep dots readable when 14+ points crowd the axis: only mark the peak, the
  // ends, and hover targets, instead of a dot on every single day.
  const peakIndex = pointsXY.reduce((best, p, i) => (p.totalPaise > pointsXY[best].totalPaise ? i : best), 0);
  const dots = pointsXY.map((p, i) => {
    const notable = single || i === peakIndex || i === 0 || i === pointsXY.length - 1;
    if (!notable && pointsXY.length > 8) return '';
    const title = `<title>${escapeHtml(p.day)} — ${escapeHtml(fmt(p.totalPaise))}, ${p.saleCount} bill${p.saleCount === 1 ? '' : 's'}</title>`;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${pointsXY.length > 20 ? 2 : 3}" fill="var(--accent)">${title}</circle>`;
  }).join('');

  const singleBar = single ? `
    <rect x="${(pad.l + innerW / 2 - barW / 2).toFixed(1)}" y="${pad.t.toFixed(1)}" width="${barW.toFixed(1)}" height="${innerH.toFixed(1)}"
          rx="6" fill="var(--accent)" fill-opacity="0.18" />
    <text x="${(pad.l + innerW / 2).toFixed(1)}" y="${(pad.t - 4).toFixed(1)}" text-anchor="middle" fill="var(--text-2)" font-size="11" font-weight="600">${escapeHtml(fmt(points[0].totalPaise))}</text>` : '';

  const flatNote = hasSales ? '' : `
    <text x="${(pad.l + innerW / 2).toFixed(1)}" y="${(pad.t + innerH / 2).toFixed(1)}" text-anchor="middle"
          fill="var(--muted)" font-size="12">No sales in this window</text>`;

  return `
    <svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Daily sales trend, ${points.length} days, peak ${escapeHtml(fmt(peak))}">
      <defs>
        <linearGradient id="dashG" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridlines}
      ${area ? `<path d="${area}" fill="url(#dashG)"></path>` : ''}
      ${singleBar}
      ${!single ? `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>` : ''}
      ${dots}
      ${flatNote}
      ${ticks}
    </svg>`;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function renderDashboard() {
  const root = document.createElement('div');
  root.className = 'view view--dashboard';
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Today at a glance</h1>
        <p>Live numbers from the sales ledger. Pick a date range to inspect any window.</p>
      </div>
      <div class="page-header__actions" style="display:flex; gap:8px; align-items:center;">
        <label class="muted" style="font-size: 12px;">From</label>
        <input class="input" type="date" data-role="from" />
        <label class="muted" style="font-size: 12px;">To</label>
        <input class="input" type="date" data-role="to" />
        <button class="btn" data-action="range-today">Today</button>
        <button class="btn btn--primary" data-action="refresh">Refresh</button>
      </div>
    </div>

    <div id="dashState" style="margin-bottom: 14px;"></div>

    <div class="grid grid--stats" data-role="stat-grid">
      ${stat({ label: 'Sales (range)', value: '…', loading: true })}
      ${stat({ label: 'Bills generated', value: '…', loading: true })}
      ${stat({ label: 'Average ticket', value: '…', loading: true })}
      ${stat({ label: 'Tax collected', value: '…', loading: true })}
      ${stat({ label: 'Low-stock items', value: '…', loading: true })}
    </div>

    <div class="grid grid--two" style="margin-top: 16px;">
      <div style="display: grid; gap: 16px;">
        <div class="card">
          <div class="card__header">
            <div>
              <div class="card__title">Daily sales trend</div>
              <div class="card__subtitle" data-role="range-label">—</div>
            </div>
          </div>
          <div class="card__body" data-role="trend">${loadingState('Loading daily trend…')}</div>
        </div>
        <div class="card">
          <div class="card__header">
            <div>
              <div class="card__title">Recent transactions</div>
              <div class="card__subtitle">Latest 8 invoices in range</div>
            </div>
            <button class="btn btn--ghost" data-nav="sales-history">View all</button>
          </div>
          <div class="card__body" style="padding: 0;" data-role="recent">${loadingState('Loading recent sales…')}</div>
        </div>
      </div>
      <div style="display: grid; gap: 16px;">
        <div class="card">
          <div class="card__header">
            <div>
              <div class="card__title">Best-selling products</div>
              <div class="card__subtitle">Top 8 by quantity sold</div>
            </div>
          </div>
          <div class="card__body" data-role="best">${loadingState('Loading best sellers…')}</div>
        </div>
        <div class="card">
          <div class="card__header">
            <div>
              <div class="card__title">Low-stock alerts</div>
              <div class="card__subtitle">Items at or below reorder level</div>
            </div>
            <button class="btn btn--ghost" data-nav="inventory">Manage</button>
          </div>
          <div class="card__body" style="padding: 0;" data-role="low">${loadingState('Loading low-stock items…')}</div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <div class="card__header">
        <div>
          <div class="card__title">Historical integrity</div>
          <div class="card__subtitle">Sales are append-only. Print + view are the only post-sale actions.</div>
        </div>
      </div>
      <div class="card__body" style="font-size: 13px; color: var(--text-2);">
        <p style="margin: 0;">Completed sales cannot be silently edited by the POS UI — every line, total and payment status is frozen at checkout time. Reprints and reopens always show the saved values.</p>
      </div>
    </div>
  `;

  const statGrid = root.querySelector('[data-role="stat-grid"]');
  const trendEl  = root.querySelector('[data-role="trend"]');
  const recentEl = root.querySelector('[data-role="recent"]');
  const bestEl   = root.querySelector('[data-role="best"]');
  const lowEl    = root.querySelector('[data-role="low"]');
  const stateEl  = root.querySelector('#dashState');
  const fromEl   = root.querySelector('[data-role="from"]');
  const toEl     = root.querySelector('[data-role="to"]');
  const rangeLabelEl = root.querySelector('[data-role="range-label"]');

  let profile = null;
  let recentRefreshTimer = null;

  function fmtMoney(paise) {
    return formatCurrency(paise || 0, profile);
  }

  async function loadProfile() {
    if (!settingsApi()?.getStore) return;
    const res = await settingsApi().getStore();
    if (res.ok) profile = res.data;
  }

  // The trend chart plots its own trailing window ending at the range's end
  // date, so it must be labelled with the days actually drawn — not the
  // filter bounds. Under the default (today -> today) range the chart shows a
  // 14-day window while the header said "today", which is what made the chart
  // look broken next to its own caption.
  function setRangeLabel(summary, trend) {
    if (trend && trend.length > 1) {
      const totalPaise = trend.reduce((s, t) => s + (t.totalPaise || 0), 0);
      rangeLabelEl.textContent =
        `${trend[0].day} → ${trend[trend.length - 1].day} · ${trend.length} days · ${fmtMoney(totalPaise)}`;
      return;
    }
    if (summary.from && summary.to) {
      rangeLabelEl.textContent = `${summary.from} → ${summary.to}`;
      return;
    }
    rangeLabelEl.textContent = `${todayIso()} (today)`;
  }

  function paintStats({ summary, today, valuation, lowCount }) {
    const cards = [
      { label: 'Sales (range)', value: fmtMoney(summary.totalPaise), sub: `${summary.saleCount} bills · avg ${fmtMoney(summary.avgTicketPaise)}` },
      { label: 'Bills generated', value: String(summary.saleCount), sub: `${fmtMoney(summary.paidPaise)} paid` },
      { label: 'Average ticket', value: fmtMoney(summary.avgTicketPaise), sub: summary.saleCount ? 'Across range' : 'No sales yet' },
      { label: 'Tax collected', value: fmtMoney(summary.taxPaise), sub: `${today.saleCount} bills today` },
      { label: 'Low-stock items', value: String(lowCount), sub: `${valuation.totalUnits} units in stock`, kind: lowCount > 0 ? 'down' : 'up' }
    ];
    statGrid.replaceChildren(...cards.map(stat));
  }

  function paintTrend(trend) {
    if (!trend.length) {
      trendEl.innerHTML = emptyState('No days to plot — pick an end date on or before today.', 'soft');
      return;
    }
    // Draw at the card's real pixel width. The chart used to carry a fixed
    // 600px viewBox stretched with preserveAspectRatio="none", which smeared
    // the line and the axis labels whenever the window was a different width.
    const width = Math.max(320, Math.round(trendEl.clientWidth || 600));
    trendEl.innerHTML = trendSvg(
      trend.map(d => ({ day: d.day, totalPaise: d.totalPaise, saleCount: d.saleCount })),
      width,
      180,
      (paise) => fmtMoney(paise)
    );
  }

  function paintRecent(rows) {
    if (!rows.length) {
      recentEl.innerHTML = emptyState('No transactions in this range yet.', 'soft');
      return;
    }
    const body = rows.map((r) => `
      <tr>
        <td><code>${escapeHtml(r.bill_number)}</code></td>
        <td>${escapeHtml(saleTimestamp(r))}</td>
        <td>${escapeHtml(r.cashier_name || '—')}</td>
        <td class="num">${escapeHtml(String(r.item_count || 0))}</td>
        <td class="num"><strong>${escapeHtml(fmtMoney(r.total_paise))}</strong></td>
        <td><span class="pill ${escapeHtml(statusClass(r.payment_status))}">${escapeHtml(statusLabel(r.payment_status))}</span></td>
      </tr>`).join('');
    recentEl.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>Invoice</th><th>Date</th><th>Cashier</th>
          <th class="num">Items</th><th class="num">Total</th><th>Status</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function paintBest(rows) {
    if (!rows.length) {
      bestEl.innerHTML = emptyState('No items sold yet in this range.', 'soft');
      return;
    }
    const max = Math.max(1, ...rows.map(r => r.quantitySold));
    bestEl.innerHTML = rows.map((r) => `
      <div class="bar-row">
        <span class="bar-row__label">${escapeHtml(r.productName)}</span>
        <div class="bar-row__track">
          <div class="bar-row__fill" style="width: ${(r.quantitySold / max * 100).toFixed(1)}%;"></div>
        </div>
        <span class="bar-row__value">${r.quantitySold}</span>
      </div>`).join('');
  }

  function paintLowStock(rows) {
    if (!rows.length) {
      lowEl.innerHTML = emptyState('Nothing is below its reorder threshold right now. 🎉', 'soft');
      return;
    }
    const body = rows.map((p) => `
      <tr class="${Number(p.stock_quantity) <= Number(p.min_stock_level) ? 'row--low' : ''}">
        <td><code>${escapeHtml(p.sku)}</code></td>
        <td>${escapeHtml(p.name)}</td>
        <td class="num">${escapeHtml(String(p.stock_quantity))}</td>
        <td class="num">${escapeHtml(String(p.min_stock_level))}</td>
        <td><span class="pill pill--low">Reorder</span></td>
      </tr>`).join('');
    lowEl.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>SKU</th><th>Product</th>
          <th class="num">In stock</th><th class="num">Reorder at</th><th>Status</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  async function refresh() {
    stateEl.innerHTML = `<div class="banner banner--loading" role="status">Refreshing dashboard…</div>`;
    const filters = { from: fromEl.value || '', to: toEl.value || '' };
    const res = await reportsApi().dashboard({ ...filters, recentLimit: 8, trendLimit: 14 });
    if (!res.ok) {
      stateEl.innerHTML = `<div class="banner banner--error" role="status">${escapeHtml(res.error?.message || 'Could not load dashboard.')}</div>`;
      return;
    }
    stateEl.innerHTML = '';
    setRangeLabel(res.data.summary, res.data.trend);
    paintStats(res.data);
    paintTrend(res.data.trend);
    paintRecent(res.data.recent);
    paintBest(res.data.bestSellers);
    paintLowStock(res.data.lowStock);
  }

  // Default range: today, so the dashboard reflects the live cashier.
  fromEl.value = todayIso();
  toEl.value   = todayIso();

  // Re-render on data changes (sales, settings) without overriding the
  // current selection. Heavy queries are debounced so a burst of events
  // doesn't thrash SQLite.
  function scheduleRefresh() {
    clearTimeout(recentRefreshTimer);
    recentRefreshTimer = setTimeout(refresh, 250);
  }

  root.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav && window.__quickbill?.navigate) {
      // navigate() (not showView) so the URL stays in sync and a reload
      // restores this screen instead of dropping the cashier back.
      window.__quickbill.navigate(nav.dataset.nav);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'refresh') return refresh();
    if (btn.dataset.action === 'range-today') {
      fromEl.value = todayIso();
      toEl.value   = todayIso();
      refresh();
    }
  });
  fromEl.addEventListener('change', refresh);
  toEl.addEventListener('change', refresh);

  // Registered on `window`, so they MUST be released through the shell's
  // teardown contract: the shell replaces #content without otherwise
  // telling the view it is gone, so these listeners used to stack up on
  // every visit and fire once per past mount.
  function onDataChanged() { scheduleRefresh(); }
  async function onSettingsUpdated() {
    await loadProfile();
    scheduleRefresh();
  }
  window.addEventListener('quickbill:data-changed', onDataChanged);
  window.addEventListener('quickbill:settings-updated', onSettingsUpdated);

  loadProfile().then(refresh);

  return {
    el: root,
    dispose() {
      window.removeEventListener('quickbill:data-changed', onDataChanged);
      window.removeEventListener('quickbill:settings-updated', onSettingsUpdated);
      // Cancel the pending debounce so it cannot resolve against a
      // detached DOM tree after navigation.
      clearTimeout(recentRefreshTimer);
    }
  };
}
