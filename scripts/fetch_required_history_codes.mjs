#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const output = process.argv[2] || "data/required-history-codes.json";
const production = process.env.PUBLISH_PRODUCTION === "true";
if (!production) {
  await setBootstrapRequired(false);
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
  await writeCodes([]);
  process.exit(0);
}
await setBootstrapRequired(false);

const index = JSON.parse(indexText);
if (!Array.isArray(index.entries)) {
  throw new Error("signal-history-index entries are invalid.");
}

const entries = index.entries
  .filter((entry) => entry?.status === "ready" && typeof entry.date === "string")
  .sort((left, right) => right.date.localeCompare(left.date))
  .slice(0, 2);
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
