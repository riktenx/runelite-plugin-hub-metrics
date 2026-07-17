const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

function formatCompact(n) {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function formatWeekLabel(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZoneName: "short",
  });
}

// Monday (UTC) of the week containing `date` — mirrors aggregate.mjs's weekOf bucketing, so we
// can identify (and drop) the still-in-progress current week: its counts grow throughout the
// week, which reads as a drop/spike artifact in both the stat tile and the charts until the
// week actually closes.
function weekOf(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (utc.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  utc.setUTCDate(utc.getUTCDate() - dayNum);
  return utc.toISOString().slice(0, 10);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatMonthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}`;
}

function niceMax(raw) {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * pow;
}

// Smallest multiple of `step` strictly greater than `raw` (axis ceiling for fixed-increment axes).
function niceMaxStep(raw, step) {
  if (raw <= 0) return step;
  return (Math.floor(raw / step) + 1) * step;
}

// Max labels the 960-wide chart body can show without crowding. Angled labels take less
// horizontal footprint than upright ones, so this can run higher than a horizontal-label axis
// would allow. Fixed against the SVG's own viewBox units, so it holds regardless of display size.
const MAX_AXIS_TICKS = 12;

// Evenly-spaced-by-index ticks (always includes the first and last point), rather than snapping
// to calendar boundaries — calendar months/quarters don't contain the same number of weekly
// samples, so boundary-aligned ticks end up unevenly spaced in pixel space. Anchored to the most
// recent sample and stepped backward by a constant integer gap, so the spacing between every
// pair of ticks is identical (no "skips a week" artifact from rounding fractional positions).
function evenTicks(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil((n - 1) / (max - 1));
  const ticks = [];
  for (let i = n - 1; i >= 0; i -= step) ticks.push(i);
  return ticks.reverse();
}

// Weekly samples ('YYYY-MM-DD') get mm/dd/yy; monthly samples ('YYYY-MM', from the added/removed
// bar chart) are already one point per month, so just mm/yy.
function formatAxisLabel(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return d ? `${m}/${d}/${y.slice(2)}` : `${m}/${y.slice(2)}`;
}

// ---- Chart card scaffold: title/subtitle + chart<->table toggle -------------------------

function chartCard(parent, { title, subtitle, buildChart, buildTable }) {
  const card = el("div", { class: "card" });
  const chartHost = el("div", { class: "chart-wrap" });
  const tableHost = el("div", { class: "data-table-wrap" });
  tableHost.style.display = "none";

  const toggle = el("button", { class: "table-toggle", type: "button" }, "View as table");
  toggle.addEventListener("click", () => {
    const showingTable = tableHost.style.display !== "none";
    tableHost.style.display = showingTable ? "none" : "block";
    chartHost.style.display = showingTable ? "block" : "none";
    toggle.textContent = showingTable ? "View as table" : "View as chart";
  });

  card.append(
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h2", {}, title),
        subtitle ? el("div", { class: "subtitle" }, subtitle) : "",
      ]),
      toggle,
    ]),
    chartHost,
    tableHost,
  );
  parent.appendChild(card);

  buildChart(chartHost);
  buildTable(tableHost);
  return card;
}

function dataTable(host, { columns, rows }) {
  const table = el("table", { class: "data-table" });
  const thead = el("thead", {}, el("tr", {}, columns.map((c) => el("th", { class: c.num ? "num" : "" }, c.label))));
  const tbody = el("tbody", {}, rows.map((row) =>
    el("tr", {}, columns.map((c) => {
      const td = el("td", { class: c.num ? "num" : "" });
      td.appendChild(c.render ? c.render(row) : document.createTextNode(String(c.value(row))));
      return td;
    }))
  ));
  table.append(thead, tbody);
  host.appendChild(table);
}

function statusPill(status) {
  return el("span", { class: "status-pill" }, status);
}

// ---- Line chart (1-3 series, shared week axis) -------------------------------------------

function lineChart(host, { weeks, series, height = 260, yStep }) {
  const W = 960, H = height;
  const margin = { top: 12, right: 16, bottom: 48, left: 46 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const n = weeks.length;

  if (n === 0) {
    host.appendChild(el("div", { class: "empty-range" }, "No data in this range."));
    return;
  }

  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const yMax = yStep ? niceMaxStep(rawMax, yStep) : niceMax(rawMax * 1.15);
  const yTicks = yStep
    ? Array.from({ length: yMax / yStep + 1 }, (_, i) => i * yStep)
    : Array.from({ length: 5 }, (_, i) => (yMax / 4) * i);

  const x = (i) => margin.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => margin.top + plotH - (v / yMax) * plotH;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": host.dataset.label || "" });

  // gridlines + y labels
  const gGrid = svg("g");
  for (const v of yTicks) {
    const gy = y(v);
    gGrid.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: gy, y2: gy, stroke: "var(--gridline)", "stroke-width": 1 }));
    const label = svg("text", { x: margin.left - 8, y: gy + 4, "text-anchor": "end", "font-size": 11, fill: "var(--text-muted)" });
    label.textContent = formatCompact(Math.round(v));
    gGrid.appendChild(label);
  }
  root.appendChild(gGrid);

  // baseline
  root.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: y(0), y2: y(0), stroke: "var(--baseline)", "stroke-width": 1 }));

  // x labels: evenly-spaced literal sample dates, capped at a legible tick count. Angled with a
  // positive slope (low-left to high-right) so the _end_ of each label (text-anchor="end") sits
  // right at its data point, with a little clearance below the axis line before the text starts.
  const xTicks = evenTicks(n, MAX_AXIS_TICKS);
  const gX = svg("g");
  for (const i of xTicks) {
    const tx = x(i), ty = margin.top + plotH + 10;
    const label = svg("text", {
      x: tx, y: ty, "text-anchor": "end", "font-size": 11, fill: "var(--text-muted)",
      transform: `rotate(-40 ${tx} ${ty})`,
    });
    label.textContent = formatAxisLabel(weeks[i]);
    gX.appendChild(label);
  }
  root.appendChild(gX);

  // series lines
  const lastPoints = [];
  for (const s of series) {
    const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    root.appendChild(svg("path", { d, fill: "none", stroke: `var(--${s.color})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const lastV = s.values[n - 1];
    const marker = svg("circle", { cx: x(n - 1), cy: y(lastV), r: 4, fill: `var(--${s.color})`, stroke: "var(--surface)", "stroke-width": 2 });
    root.appendChild(marker);
    lastPoints.push({ label: s.label, color: s.color, value: lastV, ly: y(lastV) });
  }

  // direct end-labels, nudged apart if crowded
  lastPoints.sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < lastPoints.length; i++) {
    if (lastPoints[i].ly - lastPoints[i - 1].ly < 13) lastPoints[i].ly = lastPoints[i - 1].ly + 13;
  }
  for (const p of lastPoints) {
    const key = svg("line", { x1: W - margin.right + 4, x2: W - margin.right + 12, y1: p.ly, y2: p.ly, stroke: `var(--${p.color})`, "stroke-width": 2 });
    const label = svg("text", { x: W - margin.right + 16, y: p.ly + 4, "font-size": 11, fill: "var(--text-secondary)" });
    label.textContent = p.label;
    root.append(key, label);
  }

  // crosshair + tooltip
  const crosshair = svg("line", { y1: margin.top, y2: margin.top + plotH, stroke: "var(--baseline)", "stroke-width": 1, visibility: "hidden" });
  root.appendChild(crosshair);
  const hoverDots = series.map((s) => svg("circle", { r: 4, fill: `var(--${s.color})`, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
  hoverDots.forEach((d) => root.appendChild(d));

  const tooltip = el("div", { class: "tooltip" });
  host.style.position = "relative";
  host.append(root, tooltip);

  const overlay = svg("rect", { x: margin.left, y: margin.top, width: plotW, height: plotH, fill: "transparent" });
  root.appendChild(overlay);

  function showAt(i, clientX, clientY) {
    crosshair.setAttribute("x1", x(i));
    crosshair.setAttribute("x2", x(i));
    crosshair.setAttribute("visibility", "visible");
    series.forEach((s, si) => {
      hoverDots[si].setAttribute("cx", x(i));
      hoverDots[si].setAttribute("cy", y(s.values[i]));
      hoverDots[si].setAttribute("visibility", "visible");
    });

    tooltip.innerHTML = "";
    tooltip.appendChild(el("div", { class: "t-week" }, formatWeekLabel(weeks[i])));
    for (const s of series) {
      const row = el("div", { class: "t-row" });
      const keyEl = el("span", { class: "t-key" });
      keyEl.style.background = `var(--${s.color})`;
      row.append(keyEl, el("span", { class: "t-label" }, s.label), el("span", { class: "t-value" }, String(s.values[i])));
      tooltip.appendChild(row);
    }
    const hostRect = host.getBoundingClientRect();
    tooltip.style.left = `${clientX - hostRect.left}px`;
    tooltip.style.top = `${clientY - hostRect.top - 10}px`;
    tooltip.style.visibility = "visible";
  }

  function hide() {
    crosshair.setAttribute("visibility", "hidden");
    hoverDots.forEach((d) => d.setAttribute("visibility", "hidden"));
    tooltip.style.visibility = "hidden";
  }

  function handleMove(evt) {
    const rect = root.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - margin.left) / plotW) * (n - 1))));
    showAt(i, evt.clientX, evt.clientY);
  }

  overlay.addEventListener("pointermove", handleMove);
  overlay.addEventListener("pointerleave", hide);
}

// ---- Diverging bar chart (monthly added vs removed) --------------------------------------

function roundedBarPath(x, width, yFrom, yTo, roundTop) {
  const r = Math.min(4, Math.abs(yTo - yFrom), width / 2);
  const top = Math.min(yFrom, yTo);
  const bottom = Math.max(yFrom, yTo);
  if (roundTop) {
    return `M${x},${bottom} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + width - r},${top} Q${x + width},${top} ${x + width},${top + r} L${x + width},${bottom} Z`;
  }
  return `M${x},${top} L${x},${bottom - r} Q${x},${bottom} ${x + r},${bottom} L${x + width - r},${bottom} Q${x + width},${bottom} ${x + width},${bottom - r} L${x + width},${top} Z`;
}

function divergingBarChart(host, { months, pos, neg, posColor, negColor, height = 260 }) {
  const W = 960, H = height;
  const margin = { top: 12, right: 16, bottom: 48, left: 46 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const n = months.length;

  if (n === 0) {
    host.appendChild(el("div", { class: "empty-range" }, "No data in this range."));
    return;
  }

  const rawMax = Math.max(1, ...pos, ...neg);
  const yMax = niceMax(rawMax * 1.15);
  const mid = margin.top + plotH / 2;
  const half = plotH / 2;
  const y = (v) => mid - (v / yMax) * half;

  const slot = plotW / n;
  const barWidth = Math.min(18, slot * 0.6);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}` });

  root.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: mid, y2: mid, stroke: "var(--baseline)", "stroke-width": 1 }));

  const xTicks = evenTicks(n, MAX_AXIS_TICKS);
  for (const i of xTicks) {
    const cx = margin.left + slot * (i + 0.5);
    const ty = margin.top + plotH + 10;
    const label = svg("text", {
      x: cx, y: ty, "text-anchor": "end", "font-size": 11, fill: "var(--text-muted)",
      transform: `rotate(-40 ${cx} ${ty})`,
    });
    label.textContent = formatAxisLabel(months[i]);
    root.appendChild(label);
  }

  const tooltip = el("div", { class: "tooltip" });
  host.style.position = "relative";

  for (let i = 0; i < n; i++) {
    const cx = margin.left + slot * (i + 0.5) - barWidth / 2;
    if (pos[i] > 0) {
      const bar = svg("path", { d: roundedBarPath(cx, barWidth, mid, y(pos[i]), true), fill: `var(--${posColor})` });
      root.appendChild(wireBarTooltip(bar, tooltip, host, `${formatMonthLabel(months[i])} · added ${pos[i]}`));
    }
    if (neg[i] > 0) {
      const bar = svg("path", { d: roundedBarPath(cx, barWidth, mid, y(-neg[i]), false), fill: `var(--${negColor})` });
      root.appendChild(wireBarTooltip(bar, tooltip, host, `${formatMonthLabel(months[i])} · removed ${neg[i]}`));
    }
  }

  host.append(root, tooltip);
}

function wireBarTooltip(bar, tooltip, host, text) {
  bar.addEventListener("pointermove", (evt) => {
    tooltip.textContent = text;
    const hostRect = host.getBoundingClientRect();
    tooltip.style.left = `${evt.clientX - hostRect.left}px`;
    tooltip.style.top = `${evt.clientY - hostRect.top - 10}px`;
    tooltip.style.visibility = "visible";
  });
  bar.addEventListener("pointerleave", () => { tooltip.style.visibility = "hidden"; });
  return bar;
}

function legendRow(host, items) {
  const legend = el("div", { class: "legend" }, items.map((it) => {
    const swatch = el("span", { class: `legend-swatch ${it.bar ? "bar" : ""}` });
    swatch.style.background = `var(--${it.color})`;
    return el("span", { class: "legend-item" }, [swatch, it.label]);
  }));
  host.appendChild(legend);
}

// ---- Date range control ---------------------------------------------------------------------

const RANGE_PRESETS = [
  { key: "1m", label: "1M", months: 1 },
  { key: "3m", label: "3M", months: 3 },
  { key: "6m", label: "6M", months: 6 },
  { key: "1y", label: "1Y", months: 12 },
];

function addMonthsUTC(iso, delta) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

function filterByRange(rows, field, start, end) {
  return rows.filter((r) => r[field] >= start && r[field] <= end);
}

function presetRange(preset, minDate, maxDate) {
  const end = maxDate;
  const start = addMonthsUTC(end, -preset.months);
  return { start: start > minDate ? start : minDate, end };
}

// Preset buttons (1M/3M/6M/1Y/All) + a custom from/to date range, sharing one filter across
// every time-series chart on the page. `defaultKey` picks which preset is active on first
// render. "All" spans [minDate, maxDate] — the earliest and latest weeks actually in the ledger.
function dateRangeControl(host, { minDate, maxDate, defaultKey, onChange }) {
  const bar = el("div", { class: "range-control" });
  const presetRow = el("div", { class: "range-presets" });
  const customRow = el("div", { class: "range-custom" });
  customRow.style.display = "none";

  const buttons = [];
  function setActive(key) {
    for (const b of buttons) b.btn.classList.toggle("active", b.key === key);
    customRow.style.display = key === "custom" ? "flex" : "none";
  }

  for (const preset of RANGE_PRESETS) {
    const btn = el("button", { class: "range-btn", type: "button" }, preset.label);
    btn.addEventListener("click", () => {
      const range = presetRange(preset, minDate, maxDate);
      fromInput.value = range.start;
      toInput.value = range.end;
      setActive(preset.key);
      onChange(range);
    });
    buttons.push({ key: preset.key, btn });
    presetRow.appendChild(btn);
  }

  const defaultPreset = RANGE_PRESETS.find((p) => p.key === defaultKey) || RANGE_PRESETS[2];
  const defaultRange = presetRange(defaultPreset, minDate, maxDate);

  const allBtn = el("button", { class: "range-btn", type: "button" }, "All");
  allBtn.addEventListener("click", () => {
    const range = { start: minDate, end: maxDate };
    fromInput.value = range.start;
    toInput.value = range.end;
    setActive("all");
    onChange(range);
  });
  buttons.push({ key: "all", btn: allBtn });
  presetRow.appendChild(allBtn);

  const customBtn = el("button", { class: "range-btn", type: "button" }, "Custom");
  customBtn.addEventListener("click", () => {
    setActive("custom");
    onChange({ start: fromInput.value, end: toInput.value });
  });
  buttons.push({ key: "custom", btn: customBtn });
  presetRow.appendChild(customBtn);

  const fromInput = el("input", { type: "date", class: "range-date", min: minDate, max: maxDate, value: defaultRange.start });
  const toInput = el("input", { type: "date", class: "range-date", min: minDate, max: maxDate, value: defaultRange.end });
  function applyCustom() {
    let start = fromInput.value || minDate;
    let end = toInput.value || maxDate;
    if (start > end) [start, end] = [end, start];
    fromInput.value = start;
    toInput.value = end;
    setActive("custom");
    onChange({ start, end });
  }
  fromInput.addEventListener("change", applyCustom);
  toInput.addEventListener("change", applyCustom);
  customRow.append(el("span", {}, "From"), fromInput, el("span", {}, "to"), toInput);

  bar.append(presetRow, customRow);
  host.appendChild(bar);
  setActive(defaultPreset.key);
  onChange(defaultRange);
}

// ---- Stat tiles ----------------------------------------------------------------------------

function statTile(parent, { label, value, delta }) {
  const tile = el("div", { class: "stat-tile" }, [
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
  ]);
  if (delta) {
    tile.appendChild(el("div", { class: `delta ${delta.direction || ""}` }, delta.text));
  }
  parent.appendChild(tile);
}

// ---- Main ------------------------------------------------------------------------------

function monthlyRollup(weekly) {
  const byMonth = new Map();
  for (const w of weekly) {
    const month = w.week.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, { month, pluginsAdded: 0, pluginsRemoved: 0 });
    const m = byMonth.get(month);
    m.pluginsAdded += w.pluginsAdded;
    m.pluginsRemoved += w.pluginsRemoved;
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

async function main() {
  const [weekly, backlog, latency, plugins, authors, state] = await Promise.all([
    fetchJSON("data/aggregates/weekly.json"),
    fetchJSON("data/aggregates/backlog.json"),
    fetchJSON("data/aggregates/latency.json"),
    fetchJSON("data/aggregates/plugins.json"),
    fetchJSON("data/aggregates/authors.json"),
    fetchJSON("data/state.json"),
  ]);

  // Drop the still-in-progress current week everywhere below (stat tile and every time-series
  // chart) — its counts are a partial week, not a comparable data point yet.
  const currentWeek = weekOf(new Date());
  const weeklyComplete = weekly.filter((w) => w.week < currentWeek);
  const backlogComplete = backlog.filter((w) => w.week < currentWeek);
  const latencyComplete = latency.filter((w) => w.week < currentWeek);

  // --- stat tiles ---
  const statHost = document.getElementById("stats");
  const lastWeek = weeklyComplete[weeklyComplete.length - 1];
  const prevWeek = weeklyComplete[weeklyComplete.length - 2];
  const totalMerged = weekly.reduce((sum, w) => sum + w.merged, 0);
  const activePlugins = plugins.filter((p) => p.status === "active").length;
  const recentLatency = latencyComplete.slice(-4);
  const avgMedianLatency = recentLatency.length
    ? Math.round(recentLatency.reduce((s, w) => s + w.medianHours, 0) / recentLatency.length)
    : null;

  statTile(statHost, { label: "Last synced", value: formatDateTime(state.lastSyncedAt) });
  statTile(statHost, {
    label: "Merged last week",
    value: String(lastWeek.merged),
    delta: prevWeek
      ? { text: `${lastWeek.merged >= prevWeek.merged ? "+" : ""}${lastWeek.merged - prevWeek.merged} vs prior week`, direction: lastWeek.merged >= prevWeek.merged ? "up" : "down" }
      : null,
  });
  statTile(statHost, { label: "Active plugins tracked", value: formatCompact(activePlugins) });
  statTile(statHost, { label: "Merged PRs, all-time", value: formatCompact(totalMerged) });
  statTile(statHost, { label: "Median time-to-close (last 4wk)", value: avgMedianLatency !== null ? `${avgMedianLatency}h` : "—" });

  // --- time-series charts, filtered to the selected date range ---
  const chartsHost = document.getElementById("charts");

  function renderCharts(range) {
    chartsHost.innerHTML = "";
    const weeklyR = filterByRange(weeklyComplete, "week", range.start, range.end);
    const backlogR = filterByRange(backlogComplete, "week", range.start, range.end);
    const latencyR = filterByRange(latencyComplete, "week", range.start, range.end);
    const monthlyR = monthlyRollup(weeklyR);

    // --- PR activity (opened / merged / closed-unmerged) ---
    chartCard(chartsHost, {
      title: "PR activity per week",
      subtitle: "Opened vs. merged vs. closed without merging",
      buildChart(host) {
        lineChart(host, {
          weeks: weeklyR.map((w) => w.week),
          yStep: 50,
          series: [
            { key: "opened", label: "Opened", color: "blue", values: weeklyR.map((w) => w.opened) },
            { key: "merged", label: "Merged", color: "green", values: weeklyR.map((w) => w.merged) },
            { key: "closedUnmerged", label: "Closed unmerged", color: "red", values: weeklyR.map((w) => w.closedUnmerged) },
          ],
        });
        legendRow(host, [
          { label: "Opened", color: "blue" },
          { label: "Merged", color: "green" },
          { label: "Closed unmerged", color: "red" },
        ]);
      },
      buildTable(host) {
        dataTable(host, {
          columns: [
            { label: "Week of", value: (r) => formatWeekLabel(r.week) },
            { label: "Opened", num: true, value: (r) => r.opened },
            { label: "Merged", num: true, value: (r) => r.merged },
            { label: "Closed unmerged", num: true, value: (r) => r.closedUnmerged },
          ],
          rows: weeklyR,
        });
      },
    });

    // --- backlog ---
    chartCard(chartsHost, {
      title: "Open PR backlog over time",
      subtitle: "Cumulative opened minus resolved",
      buildChart(host) {
        lineChart(host, {
          weeks: backlogR.map((w) => w.week),
          yStep: 50,
          series: [{ key: "open", label: "Open PRs", color: "blue", values: backlogR.map((w) => w.openCount) }],
        });
      },
      buildTable(host) {
        dataTable(host, {
          columns: [
            { label: "Week of", value: (r) => formatWeekLabel(r.week) },
            { label: "Open PRs", num: true, value: (r) => r.openCount },
          ],
          rows: backlogR,
        });
      },
    });

    // --- plugins added/removed ---
    chartCard(chartsHost, {
      title: "Plugins added vs. removed",
      subtitle: "By month, from merged PRs that added or deleted a plugins/ file",
      buildChart(host) {
        divergingBarChart(host, {
          months: monthlyR.map((m) => m.month),
          pos: monthlyR.map((m) => m.pluginsAdded),
          neg: monthlyR.map((m) => m.pluginsRemoved),
          posColor: "blue",
          negColor: "red",
        });
        legendRow(host, [
          { label: "Added", color: "blue", bar: true },
          { label: "Removed", color: "red", bar: true },
        ]);
      },
      buildTable(host) {
        dataTable(host, {
          columns: [
            { label: "Month", value: (r) => formatMonthLabel(r.month) },
            { label: "Added", num: true, value: (r) => r.pluginsAdded },
            { label: "Removed", num: true, value: (r) => r.pluginsRemoved },
          ],
          rows: monthlyR,
        });
      },
    });

    // --- latency ---
    chartCard(chartsHost, {
      title: "Time to resolution",
      subtitle: "Hours from PR open to close (merged or rejected), by week closed",
      buildChart(host) {
        lineChart(host, {
          weeks: latencyR.map((w) => w.week),
          series: [
            { key: "median", label: "Median", color: "blue", values: latencyR.map((w) => w.medianHours) },
            { key: "p90", label: "P90", color: "orange", values: latencyR.map((w) => w.p90Hours) },
          ],
        });
        legendRow(host, [
          { label: "Median hours", color: "blue" },
          { label: "P90 hours", color: "orange" },
        ]);
      },
      buildTable(host) {
        dataTable(host, {
          columns: [
            { label: "Week of", value: (r) => formatWeekLabel(r.week) },
            { label: "Median hrs", num: true, value: (r) => r.medianHours },
            { label: "P90 hrs", num: true, value: (r) => r.p90Hours },
            { label: "PRs closed", num: true, value: (r) => r.n },
          ],
          rows: latencyR,
        });
      },
    });
  }

  dateRangeControl(document.getElementById("range"), {
    minDate: weeklyComplete[0].week,
    maxDate: weeklyComplete[weeklyComplete.length - 1].week,
    defaultKey: "6m",
    onChange: renderCharts,
  });

  // --- leaderboards (table only — >7 meaningful categories, per dataviz guidance) ---
  const activeLeaderboard = [...plugins]
    .filter((p) => p.status !== "renamed")
    .sort((a, b) => b.prsLast90d - a.prsLast90d || new Date(b.lastUpdatedAt) - new Date(a.lastUpdatedAt))
    .slice(0, 25);

  const twoCol = el("div", { class: "two-col" });
  document.getElementById("tables").appendChild(twoCol);

  const leftCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("div", {}, [el("h2", {}, "Most actively developed plugins"), el("div", { class: "subtitle" }, "By merged PRs in the last 90 days")])),
  ]);
  dataTable(leftCard, {
    columns: [
      { label: "Plugin", value: (r) => r.id },
      { label: "PRs (90d)", num: true, value: (r) => r.prsLast90d },
      { label: "Last updated", value: (r) => formatWeekLabel(r.lastUpdatedAt.slice(0, 10)) },
      { label: "Status", render: (r) => statusPill(r.status) },
    ],
    rows: activeLeaderboard,
  });
  twoCol.appendChild(leftCard);

  const authorCard = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("div", {}, [el("h2", {}, "Top contributors"), el("div", { class: "subtitle" }, "By PR count, all-time")])),
  ]);
  dataTable(authorCard, {
    columns: [
      { label: "Author", value: (r) => r.login },
      { label: "PRs", num: true, value: (r) => r.prCount },
      { label: "Merged", num: true, value: (r) => r.mergedCount },
    ],
    rows: authors.slice(0, 25),
  });
  twoCol.appendChild(authorCard);
}

main().catch((err) => {
  console.error(err);
  document.getElementById("charts").textContent = `Failed to load data: ${err.message}`;
});
