# runelite-plugin-hub-metrics — design doc

Metrics dashboard for [`runelite/plugin-hub`](https://github.com/runelite/plugin-hub): PR
throughput, backlog trends, and per-plugin activity. Static site, data collected by scheduled
CI, no backend/server, no database beyond flat files committed to this repo.

Hosted at: `riktenx.github.io/runelite-plugin-hub-metrics` (GitHub Pages, "GitHub Actions" source).

Status: implemented locally (fetch, aggregate, site all working against real data) and not yet
pushed to GitHub — see §9.

## 1. Why not GitHub's built-in stats

GitHub's repo Insights (`/repos/{owner}/{repo}/stats/*`: contributors, code_frequency,
punch_card, participation) are commit-based and repo-wide. plugin-hub is one repo containing
~1,000 independent plugins, each represented by a pointer file — commit-level stats can't tell
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
        files(first: 25) {
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
- 25-file cap per PR is deliberate: normal PRs touch 1 file; if a PR ever touches more than 25,
  `changedFiles` (the total count field) will disagree with `files.nodes.length` — treat that
  mismatch as a signal to log a warning and fall back to a follow-up paginated `files` query
  for that one PR, rather than sizing every request for a rare case.

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
6. `actions/upload-pages-artifact` on `site/` + `data/aggregates` (and `data/plugins.json` for
   drill-down), then `actions/deploy-pages`. Uses Pages' "GitHub Actions" deployment source, so
   there's no `gh-pages` branch to keep in sync — the live site is whatever `main` produced,
   deployed straight from the artifact.
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

Pages: a stat-tile row (open PRs, merged this week + delta, active plugins, all-time merged,
median close time), the PR-activity/backlog/added-removed/latency charts, and two leaderboard
tables (most-active plugins by `prsLast90d`, top authors) — leaderboards are tables, not charts,
per the "more than ~7 meaningful categories → table" rule.

## 9. Implementation status

All of this has been built and run against real data (13,635 PRs, 2,086 active plugins):

1. `scripts/fetch.mjs` backfill — done. Record counts matched the live totals in §2 exactly
   (11,536 merged / 2,079 closed / 20 open).
2. `scripts/aggregate.mjs` — done; weekly/backlog/latency/plugins/authors aggregates spot-checked
   against `gh pr list` and cross-checked against the Git Trees API (see the gotcha in §2).
3. `sync.yml` — written, not yet run in CI (needs the GitHub repo to exist first).
4. Static site — done, smoke-tested headlessly (jsdom) against the real aggregates: zero runtime
   errors, correct element/row counts, no `NaN`/`undefined` in any generated SVG path.
5. Per-plugin drill-down page — not built. Still optional/later, per §3.

Not yet done: pushing this to GitHub, enabling Pages, and watching the first scheduled run
actually deploy. That's a deliberate stopping point — creating the public repo and turning on
CI meaningfully affects the account it's made under, so it's happening as an explicit, separate,
confirmed step rather than bundled into local implementation.

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
