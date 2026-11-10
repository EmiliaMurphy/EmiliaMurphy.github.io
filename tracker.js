/**
 * tracker.js — Application logic for the RMB Infrastructure Tracker
 *
 * Responsibilities:
 *   1. Hold the dataset (DATA_CSV) and the five stage definitions (STAGES)
 *   2. Filter the data by stage, instrument checkboxes and timeline position
 *   3. Draw the choropleth map (country shading, tooltips)
 *   4. Update the stats cards and the data table
 *
 * Depends on: geo-data.js (defines the global GEO) — load it first.
 */
(function () {
  'use strict';

  /* ======================================================================
   * 1. DATA
   * Add new rows here. One row per line, comma-separated:
   *   Type, Continent, Country, ISO3, Date (Mon-YY), Yuan amount, USD amount
   * Amounts accept a "B" (billion) or "M" (million) suffix; leave blank if
   * undisclosed. "Type" must match one of the instrument names in STAGES.
   * ==================================================================== */
  const DATA_CSV = `Panda,Africa,Egypt,EGY,Oct-23,3.5B,478.7M
Panda,Asia,Pakistan,PAK,May-26,1.75B,250M
Panda,Asia,Indonesia,IDN,Jul-26,7B,1.03B
Panda,Asia,Kazakhstan,KAZ,May-26,3.4B,500M
Panda,Asia,Kazakhstan,KAZ,Sep-26,6.6B,983M
Panda,Asia,Philippines,PHL,Mar-18,1.46B,218M
Panda,Europe,Poland,POL,Jun-16,3B,451M
Panda,Europe,Hungary,HUN,Apr-16,1B,
Panda,Europe,Hungary,HUN,Dec-18,2B,
Panda,Europe,Hungary,HUN,Dec-21,1B,
Panda,Europe,Hungary,HUN,Nov-22,2B,
Panda,Europe,Hungary,HUN,Jul-25,5B,698M
Panda,Europe,Portugal,PRT,May-19,,
Panda,Europe,Slovenia,SVN,Mar-26,,
Dim Sum,Asia,Indonesia,IDN,Oct-25,6B,
Dim Sum,Europe,United Kingdom,GBR,Oct-14,3B,490M
Dim Sum,Europe,Portugal,PRT,Apr-26,1.99B,`;

  /**
   * The five stages of the RMB system. Each stage is one tab and lists the
   * instrument types that appear as checkboxes in the map's sidebar.
   */
  const STAGES = [
    { id: 'pricing',   name: 'Pricing',       types: ['China prices'],                                         desc: 'RMB-denominated benchmark prices' },
    { id: 'financing', name: 'Financing',     types: ['Panda', 'Dim Sum', 'Currency swap'],                    desc: 'Panda and dim sum bonds, currency swaps' },
    { id: 'risk',      name: 'Risk transfer', types: ['PBOC swap line'],                                       desc: 'PBOC bilateral swap lines' },
    { id: 'payment',   name: 'Payment',       types: ['CIPS', 'e-CNY', 'mBridge'],                             desc: 'CIPS, e-CNY, mBridge' },
    { id: 'reinvest',  name: 'Reinvestment',  types: ['Reserves', 'Bank holdings', 'Stock Connect', 'Bond Connect'], desc: 'Yuan in reserves, banks holding yuan, Stock/Bond Connect' }
  ];

  /* ======================================================================
   * 2. HELPERS — parsing and formatting
   * ==================================================================== */
  const MONTHS  = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** "3.5B" -> 3500000000, "478.7M" -> 478700000, "" -> null (undisclosed). */
  function parseMoney(text) {
    const m = (text || '').trim().match(/([\d.]+)\s*([BM])/i);
    if (!m) return null;
    return parseFloat(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
  }

  /** 3500000000 -> "3.5 B"; null -> "—". */
  function formatMoney(value) {
    if (value == null) return '—';
    if (value >= 1e9) return (value / 1e9).toFixed(2).replace(/\.?0+$/, '') + ' B';
    return (value / 1e6).toFixed(1).replace(/\.0$/, '') + ' M';
  }

  /** "Oct-23" -> a sortable month index (year * 12 + month). Used for the timeline. */
  function monthIndex(dateText) {
    const [mon, yy] = dateText.split('-');
    return (2000 + Number(yy)) * 12 + MONTHS.indexOf(mon);
  }

  const longLabel = (k) => MONTHS[k % 12] + ' ' + Math.floor(k / 12); // "Oct 2023"
  const dateLabel  = (k) => String(k % 12 + 1).padStart(2, '0') + '/' + Math.floor(k / 12); // "10/2023"

  /** Escape text before inserting it into HTML strings (defensive; data is local). */
  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Read a CSS custom property (colour token) from :root, so the map follows light/dark mode. */
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /** Linear blend between the legend's light and dark colours. t is 0..1. */
  function shade(t) {
    const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.replace('#', '').substr(i - 1, 2), 16));
    const lo = toRgb(cssVar('--lo'));
    const hi = toRgb(cssVar('--hi'));
    return 'rgb(' + lo.map((v, i) => Math.round(v + (hi[i] - v) * t)).join(',') + ')';
  }

  /* ======================================================================
   * 3. STATE
   * ==================================================================== */
  // Parse the CSV text into row objects; "k" is the month index used for filtering.
  const DATA = DATA_CSV.split('\n').map((line) => {
    const c = line.split(',');
    const row = { type: c[0], continent: c[1], country: c[2], iso: c[3], date: c[4], cny: parseMoney(c[5]), usd: parseMoney(c[6]) };
    row.k = monthIndex(row.date);
    return row;
  });

  const FIRST_MONTH = Math.floor(Math.min(...DATA.map((r) => r.k)) / 12); // first year, e.g. 2014
  const LAST_MONTH  = Math.floor(Math.max(...DATA.map((r) => r.k)) / 12); // last year, e.g. 2026

  let stage = STAGES[1];                       // currently selected tab (starts on Financing)
  let activeTypes = new Set(stage.types);      // instruments whose checkbox is ticked
  let currentMonth = LAST_MONTH;               // timeline position
  let playTimer = null;                        // setInterval handle while the timeline plays
  let byCountry = {};                          // { ISO3: { name, list: [rows] } } for the current view

  /* ======================================================================
   * 4. DOM REFERENCES
   * ==================================================================== */
  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: $('tabs'), chips: $('chips'), map: $('map'), tip: $('tipbox'), noData: $('nodata'),
    slider: $('slider'), play: $('play'), month: $('tl'),
    legendMax: $('legend-max'), statEntries: $('stat-entries'), statCountries: $('stat-countries'),
    statUsd: $('stat-usd'), table: $('tbl')
  };

  /* ======================================================================
   * 5. MAP
   * ==================================================================== */

  /** Tooltip sentence for one row, e.g. "Oct 2023: Issued a Panda bond worth ¥3.5 B / $478.7 M". */
  function describe(row) {
    const isBond = row.type === 'Panda' || row.type === 'Dim Sum';
    let amount;
    if (row.cny == null && row.usd == null) amount = 'amount undisclosed';
    else amount = (row.cny != null ? '¥' + formatMoney(row.cny) : '') +
                  (row.cny != null && row.usd != null ? ' / ' : '') +
                  (row.usd != null ? '$' + formatMoney(row.usd) : ' / $ undisclosed');
    return longLabel(row.k) + ': ' + (isBond ? 'Issued a ' + row.type + ' bond worth ' + amount : row.type + ' (' + amount + ')');
  }

  /** Build the SVG once (one <path> per country) and attach tooltip listeners. */
  function buildMap() {
    el.map.innerHTML = '<svg viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
      Object.keys(GEO).map((iso) => '<path data-iso="' + iso + '" d="' + GEO[iso][1] + '"/>').join('') + '</svg>';

    // One listener on the container (event delegation) instead of one per country.
    el.map.addEventListener('mousemove', (event) => {
      const iso = event.target.getAttribute && event.target.getAttribute('data-iso');
      if (!iso) { el.tip.style.display = 'none'; return; }
      const entry = byCountry[iso];
      el.tip.innerHTML = entry
        ? '<div class="tip"><strong>' + esc(entry.name) + '</strong>' +
          entry.list.slice().sort((a, b) => a.k - b.k).map((r) => '<div>' + esc(describe(r)) + '</div>').join('') + '</div>'
        : '<div class="tip"><strong>' + esc(GEO[iso][0]) + '</strong></div>';
      el.tip.style.display = 'block';
      el.tip.style.left = Math.max(4, Math.min(event.clientX + 14, innerWidth - 330)) + 'px';
      el.tip.style.top = (event.clientY + 14) + 'px';
    });
    el.map.addEventListener('mouseleave', () => { el.tip.style.display = 'none'; });
  }

  /** Colour every country: shaded if it has data in the current view, otherwise the "land" colour. */
  function paintMap(fills) {
    el.map.querySelectorAll('path').forEach((p) => {
      p.style.fill = fills[p.getAttribute('data-iso')] || cssVar('--land');
    });
  }

  /* ======================================================================
   * 6. RENDERING
   * ==================================================================== */

  /** Tabs along the top of the window (ARIA tab pattern). */
  function renderTabs() {
    el.tabs.innerHTML = '';
    STAGES.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(s === stage));
      b.setAttribute('aria-controls', 'panel');
      b.textContent = s.name;
      b.className = s === stage ? 'on' : '';
      b.onclick = () => { stage = s; activeTypes = new Set(s.types); render(); };
      el.tabs.appendChild(b);
    });
  }

  /** Instrument checkboxes in the map's sidebar. */
  function renderCheckboxes() {
    el.chips.innerHTML = '';
    stage.types.forEach((type) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = activeTypes.has(type);
      box.onchange = () => { box.checked ? activeTypes.add(type) : activeTypes.delete(type); render(); };
      label.append(box, document.createTextNode(type));
      el.chips.appendChild(label);
    });
  }

  /** Redraw everything that depends on state. Called after any control changes. */
  function render() {
    renderTabs();
    renderCheckboxes();

    el.slider.value = currentMonth;
    el.month.textContent = currentMonth; // e.g. "2023"

    // Rows for this stage, then the subset that is ticked AND issued on/before the timeline month.
    const stageRows = DATA.filter((r) => stage.types.includes(r.type));
    const rows = stageRows.filter((r) => activeTypes.has(r.type) && Math.floor(r.k / 12) <= currentMonth);

    // Group the visible rows by country.
    byCountry = {};
    rows.forEach((r) => { (byCountry[r.iso] = byCountry[r.iso] || { name: r.country, list: [] }).list.push(r); });

    // Colour scale is fixed to each country's FINAL total (all dates), so a country
    // with one entry is the same shade at every point on the timeline.
    const totals = {};
    stageRows.filter((r) => activeTypes.has(r.type)).forEach((r) => { totals[r.iso] = (totals[r.iso] || 0) + 1; });
    const max = Math.max(1, ...Object.values(totals));
    el.legendMax.textContent = max;

    const fills = {};
    Object.keys(byCountry).forEach((iso) => {
      const count = byCountry[iso].list.length;
      fills[iso] = shade(max === 1 ? 1 : 0.15 + 0.85 * (count - 1) / (max - 1));
    });
    paintMap(fills);

    // Placeholder message for stages that have no data yet.
    el.noData.innerHTML = stageRows.length ? '' : '<span>No data loaded yet for ' + esc(stage.desc) + '</span>';

    // Stats cards.
    const usdTotal = rows.reduce((sum, r) => sum + (r.usd || 0), 0);
    el.statEntries.textContent = rows.length;
    el.statCountries.textContent = Object.keys(byCountry).length;
    el.statUsd.textContent = usdTotal ? '$' + formatMoney(usdTotal) : '—';

    // Data table, newest first.
    el.table.innerHTML = rows.length
      ? '<caption class="sr-only">Entries shown on the map</caption>' +
        '<thead><tr><th scope="col">Type</th><th scope="col">Continent</th><th scope="col">Country</th><th scope="col">Date</th><th scope="col">Yuan</th><th scope="col">USD</th></tr></thead><tbody>' +
        rows.slice().sort((a, b) => b.k - a.k).map((r) =>
          '<tr><td>' + esc(r.type) + '</td><td>' + esc(r.continent) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.date) +
          '</td><td>' + formatMoney(r.cny) + '</td><td>' + formatMoney(r.usd) + '</td></tr>').join('') + '</tbody>'
      : '';
  }

  /* ======================================================================
   * 7. TIMELINE CONTROLS
   * ==================================================================== */
  el.slider.min = FIRST_MONTH;
  el.slider.max = LAST_MONTH;
  el.slider.oninput = () => { currentMonth = Number(el.slider.value); render(); };

  function stopPlaying() {
    clearInterval(playTimer);
    playTimer = null;
    el.play.textContent = '▶ Play';
  }

  el.play.onclick = () => {
    if (playTimer) { stopPlaying(); return; }              // second click pauses
    if (currentMonth >= LAST_MONTH) currentMonth = FIRST_MONTH; // restart from the beginning
    el.play.textContent = '❚❚ Pause';
    playTimer = setInterval(() => {
      currentMonth += 1;
      if (currentMonth >= LAST_MONTH) { currentMonth = LAST_MONTH; stopPlaying(); }
      render();
    }, 700);
  };

  /* ======================================================================
   * 8. START
   * ==================================================================== */
  buildMap();
  render();
  // Re-read the colour tokens when the OS switches between light and dark mode.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(render, 50));
})();
