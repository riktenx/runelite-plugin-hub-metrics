# runelite-plugin-hub-metrics

PR throughput, backlog, and per-plugin activity metrics for
[`runelite/plugin-hub`](https://github.com/runelite/plugin-hub).

Live dashboard: **https://riktenx.github.io/runelite-plugin-hub-metrics/**

Data is synced from the GitHub GraphQL API every 6 hours by
[`.github/workflows/sync.yml`](.github/workflows/sync.yml) into `data/`, then rebuilt into
small aggregate files the static site in `site/` reads directly — no backend, no database.

Design decisions, the upstream data model, schemas, and open questions are documented in
[`CLAUDE.md`](CLAUDE.md).

## Running locally

```
GITHUB_TOKEN=$(gh auth token) node scripts/fetch.mjs   # incremental sync (full backfill on first run)
node scripts/aggregate.mjs                             # rebuild data/aggregates/*.json
python3 -m http.server -d site 8000                     # serve the dashboard, then also expose data/
```

The site expects `data/aggregates/*.json` to be reachable at `data/aggregates/` relative to
`site/index.html` — in CI these are copied alongside the site before deploy (see the workflow).
For local serving, run the static server from the repo root instead, or symlink `data/` into
`site/`.
