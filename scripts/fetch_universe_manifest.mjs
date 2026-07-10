#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const output = process.argv[2] || "data/prior-universe-manifest.json";
const production = process.env.PUBLISH_PRODUCTION === "true";

if (!production) {
  await writeManifest(null);
  process.exit(0);
}

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const namespaceId = requiredEnv("KV_NAMESPACE_ID");
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
const headers = { Authorization: `Bearer ${apiToken}` };

let manifestText = null;
let sourceKey = null;
const indexText = await get("signal-history-index");
if (indexText) {
  const index = parseJson(indexText, "signal-history-index");
  const entries = Array.isArray(index.entries)
    ? [...index.entries].filter((entry) => entry?.status === "ready").sort((left, right) => right.date.localeCompare(left.date))
    : [];
  for (const entry of entries) {
    if (!isSafeUniverseKey(entry.universeManifestKey, entry.universeManifestRevision)) continue;
    manifestText = await get(entry.universeManifestKey);
    if (manifestText) {
      sourceKey = entry.universeManifestKey;
      break;
    }
  }
}

if (!manifestText) {
  manifestText = await get("signal-universe-manifest");
  if (manifestText) sourceKey = "signal-universe-manifest";
}

const manifest = manifestText ? parseJson(manifestText, sourceKey) : null;
await writeManifest(manifest);
console.log(manifest
  ? `Prepared prior universe ${manifest.revision ?? "unknown"} from ${sourceKey}.`
  : "No accepted universe manifest exists; the next complete run will bootstrap it.");

async function get(key) {
  const response = await fetch(`${base}/${encodeURIComponent(key)}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`KV GET ${key} failed: ${response.status} ${await response.text()}`);
  return await response.text();
}

async function writeManifest(value) {
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value)}\n`, "utf8");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function isSafeUniverseKey(key, revision) {
  return typeof revision === "string"
    && /^[0-9a-f]{16}$/.test(revision)
    && key === `signal-universe-manifest:v:${revision}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
