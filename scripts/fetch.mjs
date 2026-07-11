#!/usr/bin/env node
// Incremental (or, on first run, full-backfill) sync of runelite/plugin-hub PRs into
// data/prs.ndjson, using the GitHub GraphQL API. See CLAUDE.md section 4-5 for the design.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const PRS_PATH = DATA_DIR + "prs.ndjson";
const STATE_PATH = DATA_DIR + "state.json";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN env var is required");
  process.exit(1);
}

const OWNER = "runelite";
const REPO = "plugin-hub";
const PAGE_SIZE = 50;
const FILES_PER_PR = 25;
const REQUEST_DELAY_MS = 250;

const QUERY = `
query($cursor: String) {
  repository(owner: "${OWNER}", name: "${REPO}") {
    pullRequests(first: ${PAGE_SIZE}, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        author { login }
        createdAt
        closedAt
        mergedAt
        updatedAt
        changedFiles
        files(first: ${FILES_PER_PR}) {
          nodes { path additions deletions changeType }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphql(cursor) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "runelite-plugin-hub-metrics-fetch",
    },
    body: JSON.stringify({ query: QUERY, variables: { cursor } }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// A real plugin pointer file is a direct child of plugins/ — "plugins/<name>", nothing nested.
// Historical template/scaffold paths (e.g. "plugins/templateplugin/README.md") and root-level
// housekeeping files (e.g. "runelite.version") must NOT be mistaken for plugin ids.
const PLUGIN_PATH_RE = /^plugins\/([^/]+)$/;

function toRecord(node) {
  const files = [];
  for (const f of node.files.nodes) {
    const match = f.path.match(PLUGIN_PATH_RE);
    if (!match) continue;
    files.push({ plugin: match[1], changeType: f.changeType, additions: f.additions, deletions: f.deletions });
  }
  return {
    number: node.number,
    title: node.title,
    author: node.author?.login ?? null,
    state: node.state,
    createdAt: node.createdAt,
    closedAt: node.closedAt,
    mergedAt: node.mergedAt,
    updatedAt: node.updatedAt,
    files,
  };
}

function loadExistingLedger() {
  const map = new Map();
  if (existsSync(PRS_PATH)) {
    const lines = readFileSync(PRS_PATH, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const rec = JSON.parse(line);
      map.set(rec.number, rec);
    }
  }
  return map;
}

function loadState() {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  }
  return null;
}

function writeLedger(map) {
  const sorted = [...map.values()].sort((a, b) => a.number - b.number);
  const ndjson = sorted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PRS_PATH, ndjson);
  return sorted.length;
}

async function main() {
  const state = loadState();
  const watermark = state?.lastSyncedAt ?? null;
  const ledger = loadExistingLedger();

  console.log(
    watermark
      ? `Incremental sync since ${watermark}`
      : "No prior state — running full backfill",
  );

  let cursor = null;
  let page = 0;
  let newestSeenUpdatedAt = null;
  let newestSeenNumber = null;
  let touched = 0;
  let stop = false;

  while (!stop) {
    page += 1;
    const data = await graphql(cursor);
    const { pullRequests } = data.repository;
    console.log(
      `page ${page}: ${pullRequests.nodes.length} PRs, rateLimit cost=${data.rateLimit.cost} remaining=${data.rateLimit.remaining}`,
    );

    for (const node of pullRequests.nodes) {
      if (newestSeenUpdatedAt === null) {
        newestSeenUpdatedAt = node.updatedAt;
        newestSeenNumber = node.number;
      }
      if (watermark && node.updatedAt <= watermark) {
        stop = true;
        break;
      }
      ledger.set(node.number, toRecord(node));
      touched += 1;
    }

    if (!stop) {
      if (!pullRequests.pageInfo.hasNextPage) break;
      cursor = pullRequests.pageInfo.endCursor;
      await sleep(REQUEST_DELAY_MS);
    }

    if (data.rateLimit.remaining < 100) {
      const waitMs = new Date(data.rateLimit.resetAt).getTime() - Date.now() + 5000;
      console.log(`Rate limit low, sleeping ${Math.max(waitMs, 0)}ms`);
      await sleep(Math.max(waitMs, 0));
    }
  }

  const total = writeLedger(ledger);

  if (newestSeenUpdatedAt) {
    writeFileSync(
      STATE_PATH,
      JSON.stringify(
        { lastSyncedAt: newestSeenUpdatedAt, lastSyncedPrNumber: newestSeenNumber },
        null,
        2,
      ) + "\n",
    );
  }

  console.log(`Done. ${touched} PR records upserted this run, ${total} total in ledger.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
