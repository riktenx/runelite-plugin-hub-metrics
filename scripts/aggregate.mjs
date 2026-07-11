#!/usr/bin/env node
// Rebuilds data/aggregates/*.json from data/prs.ndjson. Pure function of the ledger — safe to
// re-run any time, never talks to the network. See CLAUDE.md section 5.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const AGG_DIR = DATA_DIR + "aggregates/";
const PRS_PATH = DATA_DIR + "prs.ndjson";

function loadLedger() {
  return readFileSync(PRS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Monday (UTC) of the week containing `iso`, as a YYYY-MM-DD string. Used as the week bucket
// key everywhere below — sortable as a string, trivially parseable as a date by chart code.
function weekOf(iso) {
  const d = new Date(iso);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (utc.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  utc.setUTCDate(utc.getUTCDate() - dayNum);
  return utc.toISOString().slice(0, 10);
}

function addWeek(weekKey) {
  const d = new Date(weekKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildWeekly(records) {
  const buckets = new Map(); // week -> {opened, merged, closedUnmerged, pluginsAdded, pluginsRemoved}

  function bump(week, field, by = 1) {
    if (!buckets.has(week)) {
      buckets.set(week, { week, opened: 0, merged: 0, closedUnmerged: 0, pluginsAdded: 0, pluginsRemoved: 0 });
    }
    buckets.get(week)[field] += by;
  }

  for (const r of records) {
    bump(weekOf(r.createdAt), "opened");

    if (r.state === "MERGED") {
      bump(weekOf(r.mergedAt), "merged");
    } else if (r.state === "CLOSED") {
      bump(weekOf(r.closedAt), "closedUnmerged");
    }

    // Plugin add/remove events only reflect reality for merged PRs — an unmerged PR never
    // touched the live tree.
    if (r.state !== "MERGED") continue;
    const added = r.files.filter((f) => f.changeType === "ADDED");
    const deleted = r.files.filter((f) => f.changeType === "DELETED");
    const isRenamePair = added.length === 1 && deleted.length === 1;
    if (isRenamePair) continue; // renames are tracked in plugins.json, not counted as churn
    if (added.length) bump(weekOf(r.mergedAt), "pluginsAdded", added.length);
    if (deleted.length) bump(weekOf(r.mergedAt), "pluginsRemoved", deleted.length);
  }

  return [...buckets.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

function fillWeekGaps(weekly) {
  if (weekly.length === 0) return weekly;
  const byWeek = new Map(weekly.map((w) => [w.week, w]));
  const out = [];
  let cursor = weekly[0].week;
  const last = weekly[weekly.length - 1].week;
  while (cursor <= last) {
    out.push(byWeek.get(cursor) ?? { week: cursor, opened: 0, merged: 0, closedUnmerged: 0, pluginsAdded: 0, pluginsRemoved: 0 });
    cursor = addWeek(cursor);
  }
  return out;
}

function buildBacklog(weeklyFilled) {
  let openCount = 0;
  return weeklyFilled.map((w) => {
    openCount += w.opened - w.merged - w.closedUnmerged;
    return { week: w.week, openCount };
  });
}

function buildLatency(records) {
  const buckets = new Map(); // week -> hours[]
  for (const r of records) {
    if (!r.closedAt) continue; // still open
    const hours = (new Date(r.closedAt) - new Date(r.createdAt)) / 3_600_000;
    const week = weekOf(r.closedAt);
    if (!buckets.has(week)) buckets.set(week, []);
    buckets.get(week).push(hours);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, hours]) => {
      const sorted = [...hours].sort((a, b) => a - b);
      return {
        week,
        medianHours: Math.round(median(sorted) * 10) / 10,
        p90Hours: Math.round(percentile(sorted, 0.9) * 10) / 10,
        n: sorted.length,
      };
    });
}

function buildPlugins(records) {
  const merged = records.filter((r) => r.state === "MERGED").sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  const plugins = new Map(); // id -> record

  for (const r of merged) {
    const added = r.files.filter((f) => f.changeType === "ADDED");
    const deleted = r.files.filter((f) => f.changeType === "DELETED");
    const modified = r.files.filter((f) => f.changeType !== "ADDED" && f.changeType !== "DELETED");
    const isRenamePair = added.length === 1 && deleted.length === 1;

    if (isRenamePair) {
      const oldId = deleted[0].plugin;
      const newId = added[0].plugin;
      const old = plugins.get(oldId);
      if (old) {
        old.status = "renamed";
        old.renamedTo = newId;
        old.lastUpdatedAt = r.mergedAt;
        old.prCount += 1;
      }
      plugins.set(newId, {
        id: newId,
        firstAddedAt: r.mergedAt,
        lastUpdatedAt: r.mergedAt,
        updateCount: 0,
        prCount: 1,
        status: "active",
      });
      continue;
    }

    for (const f of added) {
      const existing = plugins.get(f.plugin);
      plugins.set(f.plugin, {
        id: f.plugin,
        firstAddedAt: existing?.firstAddedAt ?? r.mergedAt,
        lastUpdatedAt: r.mergedAt,
        updateCount: existing?.updateCount ?? 0,
        prCount: (existing?.prCount ?? 0) + 1,
        status: "active",
      });
    }
    for (const f of modified) {
      const existing = plugins.get(f.plugin);
      plugins.set(f.plugin, {
        id: f.plugin,
        firstAddedAt: existing?.firstAddedAt ?? r.mergedAt,
        lastUpdatedAt: r.mergedAt,
        updateCount: (existing?.updateCount ?? 0) + 1,
        prCount: (existing?.prCount ?? 0) + 1,
        status: existing?.status ?? "active",
      });
    }
    for (const f of deleted) {
      const existing = plugins.get(f.plugin);
      plugins.set(f.plugin, {
        id: f.plugin,
        firstAddedAt: existing?.firstAddedAt ?? r.mergedAt,
        lastUpdatedAt: r.mergedAt,
        updateCount: existing?.updateCount ?? 0,
        prCount: (existing?.prCount ?? 0) + 1,
        status: "removed",
      });
    }
  }

  // "Actively developed" needs a trailing-window count, not just last-updated recency —
  // a plugin updated once a year ago and one updated 5 times last month both have *a*
  // lastUpdatedAt, but only one is actively worked on.
  const cutoff = Date.now() - 90 * 24 * 3_600_000;
  for (const r of merged) {
    if (new Date(r.mergedAt).getTime() < cutoff) continue;
    for (const f of r.files) {
      const p = plugins.get(f.plugin);
      if (p) p.prsLast90d = (p.prsLast90d ?? 0) + 1;
    }
  }
  for (const p of plugins.values()) p.prsLast90d ??= 0;

  return [...plugins.values()].sort((a, b) => (a.lastUpdatedAt < b.lastUpdatedAt ? 1 : -1));
}

function buildAuthors(records) {
  const authors = new Map(); // login -> {prCount, mergedCount}
  for (const r of records) {
    if (!r.author) continue;
    if (!authors.has(r.author)) authors.set(r.author, { login: r.author, prCount: 0, mergedCount: 0 });
    const a = authors.get(r.author);
    a.prCount += 1;
    if (r.state === "MERGED") a.mergedCount += 1;
  }
  return [...authors.values()].sort((a, b) => b.prCount - a.prCount).slice(0, 50);
}

function main() {
  const records = loadLedger();
  console.log(`Loaded ${records.length} PR records`);

  const weekly = fillWeekGaps(buildWeekly(records));
  const backlog = buildBacklog(weekly);
  const latency = buildLatency(records);
  const plugins = buildPlugins(records);
  const authors = buildAuthors(records);

  mkdirSync(AGG_DIR, { recursive: true });
  writeFileSync(AGG_DIR + "weekly.json", JSON.stringify(weekly, null, 2) + "\n");
  writeFileSync(AGG_DIR + "backlog.json", JSON.stringify(backlog, null, 2) + "\n");
  writeFileSync(AGG_DIR + "latency.json", JSON.stringify(latency, null, 2) + "\n");
  writeFileSync(AGG_DIR + "plugins.json", JSON.stringify(plugins, null, 2) + "\n");
  writeFileSync(AGG_DIR + "authors.json", JSON.stringify(authors, null, 2) + "\n");

  console.log(
    `Wrote aggregates: ${weekly.length} weeks, ${plugins.length} plugins tracked, ${authors.length} authors.`,
  );
}

main();
