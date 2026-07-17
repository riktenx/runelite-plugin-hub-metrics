# runelite-plugin-hub-metrics — design doc

Metrics dashboard for [`runelite/plugin-hub`](https://github.com/runelite/plugin-hub): PR
throughput, backlog trends, and per-plugin activity. Static site, data collected by scheduled
CI, no backend/server, no database beyond flat files committed to this repo.

Hosted at: `riktenx.github.io/runelite-plugin-hub-metrics` (GitHub Pages, "GitHub Actions" source).

Status: **live.** Repo pushed, Pages enabled, dashboard deployed and serving real data at the
URL above. Daily sync is running in CI — see §9.

## 1. Why not GitHub's built-in stats

GitHub's repo Insights (`/repos/{owner}/{repo}/stats/*`: contributors, code_frequency,
punch_card, participation) are commit-based and repo-wide. plugin-hub is one repo containing
~2,000 independent plugins, each represented by a pointer file — commit-level stats can't tell
you "is plugin X actively maintained" or "how long does review take," which is what's
interesting here. We need PR-level data, joined to which plugin each PR touched. That has to be
built from the PR list ourselves. Confirmed this is the only path — there's no innate
per-plugin activity API.

## 2. Confirmed upstream data model

Verified directly against the live repo (`gh api`), not assumed:

- Every plugin is a single flat file at `plugins/<plugin-id>` (not a directory). Example,
  `plugins/07flip`:
  ```
  repository=https://github.com/UserD40/Runelite07Flip.git
  commit=77defa4c61416acf1f5c9da242a6057990926417
  warning=This plugin submits your IP address to a 3rd-party server not controlled or verified by RuneLite developers.
  ```
  So **the filename under `plugins/` is the stable plugin id.** No parsing of plugin metadata
  is needed for our purposes — we only care that the file changed, not its contents.
- A PR almost always touches exactly one file (`changedFiles: 1`) — a version bump is a
  one-line commit-hash diff. Occasional PRs touch multiple files (mass fixes, policy-driven
  batch removals) — the schema below treats "files touched" as a list per PR, not a single
  field, so this isn't a special case.
- GraphQL exposes `changeType` per changed file: `ADDED` / `MODIFIED` / `DELETED` / `RENAMED`.
  This is exactly what's needed to classify a PR's effect on a plugin (new plugin / update /
  removal / rename) without diffing file contents ourselves. Confirmed via live query against
  PR #13637.
- Repo scale as of this writing: **2,086 active plugin files** (confirmed via the Git Trees API,
  `git/trees/master?recursive=1`, which is not paginated/truncated), 11,536 merged PRs, 2,079
  closed (rejected/abandoned) PRs, 20 open. Merge turnaround for simple version-bump PRs is
  often well under an hour, and the sampled rate is roughly ~50/day, so daily sync is plenty
  fresh — this is not a high-frequency-polling problem.
- **Gotcha, hit during implementation:** the Contents API (`contents/plugins`, a plain
  directory listing) silently truncates at 1,000 entries with no error or truncation flag —
  it initially looked like there were exactly 1,000 plugins, which was just where the API cut
  off. The Git Trees API's `recursive=1` listing does carry a `truncated` boolean and reports
  the true count. Anything that needs a full plugin count or listing must use the Trees API,
  not Contents.
- Not every path under `plugins/` is a bare pointer file: a few historical PRs touched
  `plugins/templateplugin/README.md`, a scaffold artifact, not a plugin. `fetch.mjs` only
  treats a changed file as a plugin if it matches `^plugins/[^/]+$` (a direct child, no further
  nesting) — anything else (that template path, or a root file like `runelite.version` that
  happens to get bumped in the same PR) is dropped before it ever reaches the ledger.

## 3. Metrics in scope

- PRs opened / merged / closed-unmerged per week (and per month, for the zoomed-out view)
- Open PR count over time (backlog size — derived from cumulative opened minus cumulative
  closed, not a separate fetch)
- Time-to-resolution distribution (created → closed/merged), trended over time, to see if
  review latency is drifting
- Plugins added / removed per week (from `ADDED`/`DELETED` file changeType on merged PRs)
- Active plugin count over time
- "Actively developed" plugins — leaderboard by merged-PR count in a trailing window (default
  90 days), and conversely, plugins with no update in over a year ("stale")
- Per-plugin timeline: first-added date, last-updated date, total update count (see §5 on why
  the current `repository=` URL is deliberately not part of this)
- Top authors by PR count (mostly plugin authors bumping their own versions, but surfaces the
  most active submitters)

## 4. Data collection strategy

**GraphQL, not REST.** REST's PR list endpoint doesn't include changed files, so REST would
need one extra request per PR (~13,600 requests) to find out which plugin each PR touched —
that blows past the 5,000/hr limit fast. GraphQL lets us fetch PRs *and* their changed files
in the same paginated query.

Query shape (verified live):

```graphql
query($cursor: String) {
  repository(owner: "runelite", name: "plugin-hub") {
    pullRequests(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state          # OPEN | CLOSED | MERGED
        author { login }
        createdAt
        closedAt
        mergedAt
        updatedAt
        changedFiles
        files(first: 100) {
          nodes { path additions deletions changeType }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

- Auth: default `secrets.GITHUB_TOKEN` in the Actions workflow. It can read any public repo
  regardless of which repo the workflow belongs to — no PAT needed for fetching. A PAT is only
  relevant if we ever need write access elsewhere, which we don't.
- **Full backfill** (first run): paginate all ~13,600 PRs, 50 at a time ≈ 275 requests. At
  GraphQL's cost-based 5,000 pts/hr, this comfortably fits in one run; log `rateLimit.cost`
  each page and back off if it ever doesn't.
- **Incremental sync** (every scheduled run after that): page through
  `orderBy: {field: UPDATED_AT, direction: DESC}` and stop as soon as a page's oldest PR is
  older than our stored `lastSyncedAt` watermark. Typically 1-2 pages per run. This also
  naturally re-picks-up PRs that changed state after our watermark (e.g., closed without
  merging), since `updatedAt` bumps on any state change.
- **File-count cap and the silent-truncation gap it can cause — found and fixed post-launch.**
  Normal PRs touch exactly 1 file; the cap only matters for a maintainer batch action touching
  many plugins in one PR at once (a normal contributor PR can't touch more than one — see the
  discussion this had in chat). It was originally set to 25 with a plan to "log a warning" on
  a mismatch that was never actually implemented — a silent gap: `files.nodes` would just be
  missing entries past 25, with no signal anywhere. Verified against the full historical ledger
  before fixing it: zero PRs have ever exceeded 24 files, so nothing was actually corrupted.
  Fixed by raising the cap to 100 (GraphQL's own max `first` per connection — the ceiling
  achievable without adding real pagination) and by comparing `node.changedFiles` (the PR's true
  total) against `node.files.nodes.length` in `toRecord()`, **throwing** on any mismatch rather
  than logging. A throw aborts the run before `writeLedger`/`state.json` are touched (see §7 /
  `fetch.mjs`'s `main()`), so it can never corrupt data — it just means "no update today,
  something unusual happened, go look." Deliberately not building general
  fetch-until-exhausted pagination for an unbounded PR size: 100 is 4x any PR ever observed, and
  paginating a case that (as far as the data shows) has never happened once is speculative
  complexity for a boundary that may never actually get hit.

## 5. Our data schema

Two layers: an append/upsert **ledger** (source of truth, one row per PR) and small
**precomputed aggregates** (what the frontend actually fetches, so page load doesn't require
parsing 13k+ records client-side).

**`data/prs.ndjson`** — one JSON object per line, keyed by PR number, newline-delimited so
incremental updates produce small, readable git diffs (append new lines, replace changed
lines) instead of rewriting one giant array:

```json
{"number":13637,"title":"Update GE Uncut","author":"uzia35","state":"MERGED","createdAt":"2026-07-11T15:08:55Z","closedAt":"2026-07-11T15:54:12Z","mergedAt":"2026-07-11T15:54:12Z","updatedAt":"2026-07-11T15:54:12Z","files":[{"plugin":"ge-uncut","changeType":"MODIFIED","additions":1,"deletions":1}]}
```

`plugin` is the file's basename under `plugins/` (the stable plugin id from §2), derived from
`path` at write time so downstream code never re-parses paths.

**`data/state.json`** — sync watermark:

```json
{"lastSyncedAt": "2026-07-11T15:54:12Z", "lastSyncedPrNumber": 13637}
```

**`data/aggregates/*.json`** — recomputed from the full ledger on every run, committed
alongside it:

- `weekly.json` — `{week, opened, merged, closedUnmerged, pluginsAdded, pluginsRemoved}[]`
- `backlog.json` — `{week, openCount}[]` (cumulative open backlog trend)
- `plugins.json` — per-plugin `{id, firstAddedAt, lastUpdatedAt, updateCount, prCount, status,
  renamedTo?, prsLast90d}`. `prsLast90d` is what actually drives the "actively developed"
  leaderboard — recency of `lastUpdatedAt` alone can't distinguish "updated once, a year ago"
  from "updated five times last month." Deliberately excludes the plugin's current
  `repository=` URL — that lives in the
  plugin-hub working tree, not in PR/file-change metadata, and fetching it would mean a second,
  unrelated data source (contents API against ~1,000 live files) bolted onto a PR-metrics
  pipeline. Out of scope unless a future need justifies it.
- `authors.json` — top authors by PR count (with merged count alongside, from the same pass)
- `latency.json` — `{week, medianHoursToClose, p90HoursToClose}[]`

Frontend never touches `prs.ndjson` directly except for on-demand per-plugin drill-down
(fetched/filtered client-side only when a user clicks into a specific plugin).

## 6. Repo layout

```
runelite-plugin-hub-metrics/
├── CLAUDE.md
├── .github/workflows/
│   └── sync.yml            # scheduled fetch + aggregate + commit + deploy
├── scripts/
│   ├── fetch.mjs            # incremental GraphQL sync -> data/prs.ndjson, data/state.json
│   └── aggregate.mjs        # data/prs.ndjson -> data/aggregates/*.json
├── data/
│   ├── prs.ndjson
│   ├── state.json
│   └── aggregates/
│       ├── weekly.json
│       ├── backlog.json
│       ├── plugins.json
│       ├── authors.json
│       └── latency.json
└── site/
    ├── index.html
    ├── main.js              # fetches data/aggregates/*.json, renders charts
    └── style.css
```

Plain JS static site, no bundler/build step required — keeps the whole pipeline dependency-light
and easy to debug by opening `data/aggregates/*.json` directly.

## 7. CI pipeline

Single workflow, `schedule` + `workflow_dispatch` triggers only (**not** `push` — this avoids a
commit-triggers-workflow loop, since the workflow itself commits to `main`).

1. `schedule: cron: '0 0 * * *'` (once daily, midnight UTC — trivially adjustable).
2. Checkout `main`.
3. `node scripts/fetch.mjs` — reads `data/state.json`, runs the incremental GraphQL sync,
   upserts into `data/prs.ndjson`, updates the watermark.
4. `node scripts/aggregate.mjs` — rebuilds `data/aggregates/*.json` from the full ledger.
5. If `git status` shows changes under `data/`: commit as a bot identity
   (`github-actions[bot]`), push directly to `main`. No PR — this is generated data, not
   authored code.
6. `actions/upload-pages-artifact` on `site/` + `data/aggregates/*.json` + `data/state.json` (the
   sync watermark, read by the frontend for the "Last synced" stat tile), then
   `actions/deploy-pages`. Uses Pages' "GitHub Actions" deployment source, so there's no
   `gh-pages` branch to keep in sync — the live site is whatever `main` produced, deployed
   straight from the artifact.
7. Workflow permissions: `contents: write`, `pages: write`, `id-token: write`.

One-time manual step (can't be scripted): enable Pages on the repo, source = "GitHub Actions",
after the repo exists.

## 8. Frontend

Static HTML/JS, no framework, no bundler, no npm dependencies — `site/main.js` builds hand-rolled
SVG charts directly (a shared multi-series line-chart renderer with crosshair tooltip + direct
end-labels, and a diverging bar-chart renderer), following the project's `dataviz` skill: fixed
mark specs (2px lines, 4px rounded bar ends, 2px surface gaps/rings), the reference categorical
palette (opened=blue, merged=green, closed-unmerged=red — chosen for semantic fit, held constant
everywhere those three appear; added=blue/removed=red as the diverging pair), a legend for every
multi-series chart, and a "view as table" toggle on every chart card (the accessibility fallback,
also just a plain, always-available way to read exact values).

Pages: a stat-tile row (last synced, merged last week + delta, active plugins, all-time merged,
median close time — no "open PRs right now" tile; that number is only ever as fresh as the last
daily sync, and calling it "right now" was misleading), the PR-activity/backlog/added-removed/
latency charts, and two leaderboard tables (most-active plugins by `prsLast90d`, top authors) —
leaderboards are tables, not charts, per the "more than ~7 meaningful categories → table" rule.

**Current (in-progress) week is excluded from stat tile and charts.** `weekly.json`'s last
bucket is whatever week contains "today" — partial by construction, since the week isn't over
yet. Originally the "merged this week" tile and every time-series chart read straight off that
bucket, which meant the number visibly grew as the week progressed and looked like a drop
right after each week rolled over — a misleading "this week" framing for a site that only
updates once a day. Fixed client-side in `main.js`: a `weekOf()` mirroring `aggregate.mjs`'s
Monday-anchored bucketing identifies the current week key, and every weekly/latency/backlog
array is filtered to strictly-before it before use — so the stat tile is "merged **last**
week" (last fully-closed week) and no chart, nor the date-range control's `minDate`/`maxDate`
bounds, can reach into the partial week. `aggregate.mjs` itself is untouched — the partial
bucket is still written to `weekly.json` (it's a correct partial count, just not one we want
surfaced as if it were final), so this stays a display-layer filter, not a data change.

**Date range control.** One control above the charts (1M/3M/6M/1Y/All presets, default 6M, plus
a custom from/to date picker) filters all four time-series charts at once. The stat tiles and
leaderboards are deliberately not range-filtered — they're "current state" / "all-time" by
design, not a trend over the selected window. "All" spans `[minDate, maxDate]` taken from the
first/last complete weeks (the in-progress current week excluded, per above), not a hardcoded
date.

**Axis behavior.** Went through a few iterations, each driven by something that only looked
wrong once real data was on screen:
- Y-axis: the two PR-count charts (PR activity, backlog) use fixed 50-unit gridline increments,
  capped at the next multiple of 50 strictly above the visible max, instead of the general
  `niceMax` scaling the other two charts (latency in hours, plugins added/removed) still use —
  those aren't PR counts, so a fixed round-number step doesn't apply to them.
- X-axis: ticks are evenly spaced *by index*, not snapped to calendar boundaries. An earlier
  version placed a tick at every month/quarter start, which looked subtly wrong once rendered —
  calendar months don't contain the same number of weekly samples, so boundary-aligned ticks
  ended up unevenly spaced in pixel space. Ticks now anchor to the most recent sample and step
  backward by a constant integer gap (`evenTicks` in `main.js`), capped at 12 labels
  (`MAX_AXIS_TICKS`) — angled labels need less horizontal room than upright ones, so this can run
  higher than a horizontal-label axis would allow. Every tick is a real sample, labeled with its
  literal date (`mm/dd/yy` for weekly data, `mm/yy` for the monthly bar chart), never an
  interpolated or calendar-snapped one. Labels are angled with a positive slope (low-left to
  high-right) so the label's *end*, not its middle, lands on the data point, with a small gap
  below the axis line before the text starts.

## 9. Implementation status

All of this has been built, pushed, and is running live:

1. `scripts/fetch.mjs` backfill — done at launch. Record counts matched the live totals in §2
   exactly (11,536 merged / 2,079 closed / 20 open at the time).
2. `scripts/aggregate.mjs` — done; weekly/backlog/latency/plugins/authors aggregates spot-checked
   against `gh pr list` and cross-checked against the Git Trees API (see the gotcha in §2).
3. `sync.yml` — pushed, Pages enabled (source = GitHub Actions), and run successfully twice via
   manual `workflow_dispatch` (fetch → aggregate → commit → deploy all verified working
   end-to-end, including a real incremental commit picked up mid-session). The `schedule` trigger
   itself hadn't fired yet as of this writing — first scheduled run is the next `00:00 UTC`.
4. Static site — done, smoke-tested headlessly (jsdom) against the real aggregates before launch
   (zero runtime errors, correct element/row counts, no `NaN`/`undefined` in any SVG path), and
   confirmed live in the browser post-deploy.
5. Per-plugin drill-down page — not built. Still optional/later, per §3.
6. The file-cap fix in §4 (100-file cap, throw on `changedFiles` mismatch) shipped after launch,
   verified with a real incremental run first (no throw, as expected) before being committed.
7. Dashboard UX pass (§8: date range control, fixed-50 y-axis for the two PR-count charts,
   evenly-spaced literal-date x-axis ticks, "Last synced" stat tile replacing "open PRs right
   now") — shipped after launch. Relative `fetch()` paths mean jsdom alone can't run the site
   (module scripts and `fetch` need a real HTTP server, not jsdom's virtual resource loader), so
   this was smoke-tested against a real local server serving `site/` + `data/` flattened the same
   way the Pages artifact does, exercised through every date-range preset plus edge cases (empty
   range, multi-year custom range spanning >12 months). Axis label angle, spacing, and clearance
   from the baseline were verified by rasterizing the actual chart SVGs to PNG and inspecting
   them (via `@resvg/resvg-js`, no browser needed) rather than just trusting the transform math —
   the slope direction was wrong on the first pass (an SVG `rotate()` sign flip) and caught this
   way once the requested direction was pinned down. Also caught a real spec bug pre-ship:
   `Intl.DateTimeFormat` throws if `dateStyle`/
   `timeStyle` are combined with `timeZoneName` (not a jsdom quirk — reproduced in plain Node),
   so the "Last synced" formatter uses individual component options instead.

**Operational note:** shortly after launch, a local commit got built on a stale `main` (fetched
the remote log to inspect it, but never actually pulled) and diverged from `origin/main`, which
the bot had since moved with its own sync commit. Rather than hand-merge the diverged data files
— risky, since `data/` is meant to be regenerated, not manually reconciled — the fix was to reset
local `main` to the true remote tip, reapply just the code/doc diff on top, and rerun
`fetch.mjs`/`aggregate.mjs` fresh against the correct base. Same "clean rebuild over hand-patching
derived data" principle as §11's recovery model, just applied to a git mistake instead of a code
bug. Take care to `git pull` (not just `git fetch` + inspect) before committing, given the bot can
push to `main` at any time.

## 10. Open questions

- Started at a 6-hour cadence, changed to daily shortly after launch (not driven by measured
  sync-duration/rate-limit data — rate limit usage was trivial either way, ~275 requests for a
  full backfill against a 5,000/hr budget; this was just a "daily is fresh enough" call). Still
  trivially adjustable if the pace of upstream activity ever calls for tighter polling.
- **Rename handling — resolved, with a known gap.** A same-PR `ADDED`+`DELETED` pair is treated
  as a rename (old id marked `renamed`/`renamedTo`, new id starts fresh) in both `weekly.json`
  (excluded from add/remove churn counts) and `plugins.json`. Verified against real data: of
  2,086 live plugins, 2,088 were tracked active (only 2 off), and the two known exceptions
  (`wilderness-multi-lines` / `method-observer`) are genuine multi-step rename chains the
  same-PR heuristic can't follow — good enough for a first cut, not chased further.

## 11. Data-quality recovery model

However confident the code is, there's no reason to assume it's bug-free — it's a normal amount
of hand-written logic, not something exhaustively proven. What actually matters is how cheap it
is to recover when a bug is found, and that differs by layer:

- **Aggregation bugs** (a miscount in `aggregate.mjs`) are free to fix: it's a pure function of
  `data/prs.ndjson` with no network calls, so fix the logic and rerun — instant, no risk.
- **Fetch/ledger bugs** (something wrong in what `fetch.mjs` extracts) are still cheap: GitHub's
  history for closed/merged PRs is immutable, so a full re-backfill (delete `state.json`, rerun)
  reconstructs a correct ledger from scratch in about 9 minutes and ~275 GraphQL requests —
  trivial against the 5,000/hr budget. This is exactly what happened for the plugin-path-filter
  bug (§2) and is *not* what was needed for the file-cap fix (§4), because that gap had never
  actually been hit by any historical PR — confirmed by checking the ledger before deciding a
  rebuild was unnecessary. Always check "has this actually corrupted existing data, or only
  future data" before reaching for a full rebuild.
- **No automated drift-detection is built, by design.** Rather than add validation machinery,
  the plan is a periodic manual check — e.g. monthly, re-run the same spot-checks done at launch
  (compare ledger-derived totals against live `gh pr list` / GraphQL counts, cross-check active
  plugin count against the Git Trees API) and look for drift. Lightweight and sufficient given
  how cheap recovery already is once something is found.
