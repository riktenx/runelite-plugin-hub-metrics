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

function formatMonthLabel(ym) {
  const d = new Date(ym + "-01T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function niceMax(raw) {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const frac = raw / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * pow;
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

function lineChart(host, { weeks, series, height = 260 }) {
  const W = 960, H = height;
  const margin = { top: 12, right: 16, bottom: 24, left: 46 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const n = weeks.length;

  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  const yMax = niceMax(rawMax * 1.15);

  const x = (i) => margin.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => margin.top + plotH - (v / yMax) * plotH;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": host.dataset.label || "" });

  // gridlines + y labels
  const gGrid = svg("g");
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (yMax / steps) * i;
    const gy = y(v);
    gGrid.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: gy, y2: gy, stroke: "var(--gridline)", "stroke-width": 1 }));
    const label = svg("text", { x: margin.left - 8, y: gy + 4, "text-anchor": "end", "font-size": 11, fill: "var(--text-muted)" });
    label.textContent = formatCompact(Math.round(v));
    gGrid.appendChild(label);
  }
  root.appendChild(gGrid);

  // baseline
  root.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: y(0), y2: y(0), stroke: "var(--baseline)", "stroke-width": 1 }));

  // x labels: ~7 ticks
  const tickEvery = Math.max(1, Math.round(n / 7));
  const gX = svg("g");
  for (let i = 0; i < n; i += tickEvery) {
    const label = svg("text", { x: x(i), y: H - 4, "text-anchor": "middle", "font-size": 11, fill: "var(--text-muted)" });
    label.textContent = formatWeekLabel(weeks[i]);
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
  const margin = { top: 12, right: 16, bottom: 24, left: 46 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const n = months.length;

  const rawMax = Math.max(1, ...pos, ...neg);
  const yMax = niceMax(rawMax * 1.15);
  const mid = margin.top + plotH / 2;
  const half = plotH / 2;
  const y = (v) => mid - (v / yMax) * half;

  const slot = plotW / n;
  const barWidth = Math.min(18, slot * 0.6);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}` });

  root.appendChild(svg("line", { x1: margin.left, x2: W - margin.right, y1: mid, y2: mid, stroke: "var(--baseline)", "stroke-width": 1 }));

  const tickEvery = Math.max(1, Math.round(n / 8));
  for (let i = 0; i < n; i += tickEvery) {
    const cx = margin.left + slot * (i + 0.5);
    const label = svg("text", { x: cx, y: H - 4, "text-anchor": "middle", "font-size": 11, fill: "var(--text-muted)" });
    label.textContent = formatMonthLabel(months[i]);
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
  const [weekly, backlog, latency, plugins, authors] = await Promise.all([
    fetchJSON("data/aggregates/weekly.json"),
    fetchJSON("data/aggregates/backlog.json"),
    fetchJSON("data/aggregates/latency.json"),
    fetchJSON("data/aggregates/plugins.json"),
    fetchJSON("data/aggregates/authors.json"),
  ]);

  // --- stat tiles ---
  const statHost = document.getElementById("stats");
  const lastWeek = weekly[weekly.length - 1];
  const prevWeek = weekly[weekly.length - 2];
  const currentOpen = backlog[backlog.length - 1]?.openCount ?? 0;
  const totalMerged = weekly.reduce((sum, w) => sum + w.merged, 0);
  const activePlugins = plugins.filter((p) => p.status === "active").length;
  const recentLatency = latency.slice(-4);
  const avgMedianLatency = recentLatency.length
    ? Math.round(recentLatency.reduce((s, w) => s + w.medianHours, 0) / recentLatency.length)
    : null;

  statTile(statHost, { label: "Open PRs right now", value: String(currentOpen) });
  statTile(statHost, {
    label: "Merged this week",
    value: String(lastWeek.merged),
    delta: prevWeek
      ? { text: `${lastWeek.merged >= prevWeek.merged ? "+" : ""}${lastWeek.merged - prevWeek.merged} vs prior week`, direction: lastWeek.merged >= prevWeek.merged ? "up" : "down" }
      : null,
  });
  statTile(statHost, { label: "Active plugins tracked", value: formatCompact(activePlugins) });
  statTile(statHost, { label: "Merged PRs, all-time", value: formatCompact(totalMerged) });
  statTile(statHost, { label: "Median time-to-close (last 4wk)", value: avgMedianLatency !== null ? `${avgMedianLatency}h` : "—" });

  // --- PR activity (opened / merged / closed-unmerged) ---
  chartCard(document.getElementById("charts"), {
    title: "PR activity per week",
    subtitle: "Opened vs. merged vs. closed without merging",
    buildChart(host) {
      lineChart(host, {
        weeks: weekly.map((w) => w.week),
        series: [
          { key: "opened", label: "Opened", color: "blue", values: weekly.map((w) => w.opened) },
          { key: "merged", label: "Merged", color: "green", values: weekly.map((w) => w.merged) },
          { key: "closedUnmerged", label: "Closed unmerged", color: "red", values: weekly.map((w) => w.closedUnmerged) },
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
        rows: weekly,
      });
    },
  });

  // --- backlog ---
  chartCard(document.getElementById("charts"), {
    title: "Open PR backlog over time",
    subtitle: "Cumulative opened minus resolved",
    buildChart(host) {
      lineChart(host, {
        weeks: backlog.map((w) => w.week),
        series: [{ key: "open", label: "Open PRs", color: "blue", values: backlog.map((w) => w.openCount) }],
      });
    },
    buildTable(host) {
      dataTable(host, {
        columns: [
          { label: "Week of", value: (r) => formatWeekLabel(r.week) },
          { label: "Open PRs", num: true, value: (r) => r.openCount },
        ],
        rows: backlog,
      });
    },
  });

  // --- plugins added/removed ---
  const monthly = monthlyRollup(weekly);
  chartCard(document.getElementById("charts"), {
    title: "Plugins added vs. removed",
    subtitle: "By month, from merged PRs that added or deleted a plugins/ file",
    buildChart(host) {
      divergingBarChart(host, {
        months: monthly.map((m) => m.month),
        pos: monthly.map((m) => m.pluginsAdded),
        neg: monthly.map((m) => m.pluginsRemoved),
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
        rows: monthly,
      });
    },
  });

  // --- latency ---
  chartCard(document.getElementById("charts"), {
    title: "Time to resolution",
    subtitle: "Hours from PR open to close (merged or rejected), by week closed",
    buildChart(host) {
      lineChart(host, {
        weeks: latency.map((w) => w.week),
        series: [
          { key: "median", label: "Median", color: "blue", values: latency.map((w) => w.medianHours) },
          { key: "p90", label: "P90", color: "orange", values: latency.map((w) => w.p90Hours) },
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
        rows: latency,
      });
    },
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
