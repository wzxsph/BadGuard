#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { earliestMissingReadyDate, needsFullHistoryBootstrap } from "./history_index.mjs";

const output = process.argv[2] || "data/required-history-codes.json";
const production = process.env.PUBLISH_PRODUCTION === "true";
if (!production) {
  await setBootstrapRequired(false);
  await setHistoryBackfillStart(null);
  await writeCodes([]);
  process.exit(0);
}

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const namespaceId = requiredEnv("KV_NAMESPACE_ID");
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
const headers = { Authorization: `Bearer ${apiToken}` };

const indexText = await get("signal-history-index");
if (!indexText) {
  await setBootstrapRequired(true);
  await setHistoryBackfillStart(null);
  await writeCodes([]);
  process.exit(0);
}

const index = JSON.parse(indexText);
if (!Array.isArray(index.entries) || !Array.isArray(index.tradingDates)) {
  throw new Error("signal-history-index entries or tradingDates are invalid.");
}

const entries = index.entries
  .filter((entry) => entry?.status === "ready" && typeof entry.date === "string")
  .sort((left, right) => right.date.localeCompare(left.date))
  .slice(0, 2);
await setBootstrapRequired(needsFullHistoryBootstrap(index.entries));
const completedThrough = latestCompletedTradingDate(index.tradingDates);
await setHistoryBackfillStart(
  completedThrough
    ? earliestMissingReadyDate(index.entries, index.tradingDates, completedThrough)
    : null
);
const codes = new Set();

for (const entry of entries) {
  const versionedKey = isSafeSnapshotKey(entry.snapshotKey, entry.date) ? entry.snapshotKey : null;
  const keys = [versionedKey, `history-snapshot:${entry.date}`, `signal-snapshot:${entry.date}`]
    .filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
  let snapshotText = null;
  for (const key of keys) {
    snapshotText = await get(key);
    if (snapshotText) break;
  }
  if (!snapshotText) {
    throw new Error(`No snapshot payload exists for indexed history date ${entry.date}.`);
  }
  const snapshot = JSON.parse(snapshotText);
  for (const board of snapshot.boards || []) {
    for (const row of board.rows || []) {
      if (/^\d{6}$/.test(String(row.code))) codes.add(String(row.code));
    }
  }
}

await writeCodes([...codes].sort());

async function get(key) {
  const response = await fetch(`${base}/${encodeURIComponent(key)}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`KV GET ${key} failed: ${response.status} ${await response.text()}`);
  return await response.text();
}

async function writeCodes(values) {
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify({ codes: values })}\n`, "utf8");
  console.log(`Prepared ${values.length} required history codes in ${output}.`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isSafeSnapshotKey(value, date) {
  if (typeof value !== "string" || !isDate(date)) return false;
  const canonical = `history-snapshot:${date}`;
  return value === canonical || new RegExp(`^${canonical}:v:[0-9a-f]{16}$`).test(value);
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function setBootstrapRequired(required) {
  if (!process.env.GITHUB_ENV) return;
  await fs.appendFile(process.env.GITHUB_ENV, `HISTORY_BOOTSTRAP_REQUIRED=${required ? "true" : "false"}\n`, "utf8");
}

async function setHistoryBackfillStart(date) {
  if (!process.env.GITHUB_ENV) return;
  await fs.appendFile(
    process.env.GITHUB_ENV,
    `HISTORY_BACKFILL_START=${date ? date.replaceAll("-", "") : ""}\n`,
    "utf8"
  );
}

function latestCompletedTradingDate(tradingDates, now = new Date()) {
  if (!Array.isArray(tradingDates)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const beforeClose = Number(parts.hour) < 15;
  return [...tradingDates]
    .filter((date) => typeof date === "string" && (date < localDate || (date === localDate && !beforeClose)))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}
