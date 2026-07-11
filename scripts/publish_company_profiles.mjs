#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
const input = args.input || "data/company-profiles.json";
const batchSize = Number(args["batch-size"] || 250);
const dryRun = args["dry-run"] === true;
const validateOnly = args["validate-only"] === true;
const sourceText = await fs.readFile(input, "utf8");
const source = JSON.parse(sourceText);

if (!source || typeof source !== "object" || Array.isArray(source)) {
  throw new Error("Company profile source must be an object keyed by six-digit stock code.");
}
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  throw new Error("batch-size must be an integer between 1 and 1000.");
}

const profiles = Object.entries(source)
  .map(([code, profile]) => validateProfile(code, profile))
  .sort((left, right) => left.code.localeCompare(right.code));
const revision = createHash("sha256").update(sourceText).digest("hex");
if (validateOnly) {
  console.log(JSON.stringify({ status: "validated", revision, count: profiles.length }, null, 2));
  process.exit(0);
}

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const namespaceId = requiredEnv("KV_NAMESPACE_ID");
const indexKey = "company-profile-index";
const existing = await getJson(indexKey);

if (existing?.revision === revision && existing?.count === profiles.length) {
  console.log(JSON.stringify({ status: "unchanged", revision, count: profiles.length }, null, 2));
  process.exit(0);
}

const previousCodes = new Set(Array.isArray(existing?.codes) ? existing.codes : []);
const nextCodes = new Set(profiles.map((profile) => profile.code));
const removedCodes = [...previousCodes].filter((code) => !nextCodes.has(code)).sort();

if (dryRun) {
  console.log(JSON.stringify({
    status: "dry-run",
    revision,
    count: profiles.length,
    batches: Math.ceil(profiles.length / batchSize),
    removedCount: removedCodes.length
  }, null, 2));
  process.exit(0);
}

for (let offset = 0; offset < profiles.length; offset += batchSize) {
  const batch = profiles.slice(offset, offset + batchSize).map((profile) => ({
    key: `company-profile:${profile.code}`,
    value: JSON.stringify(profile)
  }));
  await bulkRequest("PUT", batch);
  console.log(`Uploaded company profiles ${offset + 1}-${Math.min(offset + batch.length, profiles.length)} of ${profiles.length}.`);
}

for (let offset = 0; offset < removedCodes.length; offset += batchSize) {
  const keys = removedCodes.slice(offset, offset + batchSize).map((code) => `company-profile:${code}`);
  await bulkRequest("DELETE", keys);
}

const index = {
  version: 1,
  revision,
  count: profiles.length,
  codes: profiles.map((profile) => profile.code),
  updatedAt: new Date().toISOString()
};
await putValue(indexKey, JSON.stringify(index));

for (const profile of profiles.slice(0, 3)) {
  const stored = await getJson(`company-profile:${profile.code}`);
  if (!stored || stored.code !== profile.code) {
    throw new Error(`Company profile verification failed for ${profile.code}.`);
  }
}

console.log(JSON.stringify({ status: "published", revision, count: profiles.length, removedCount: removedCodes.length }, null, 2));

function validateProfile(code, profile) {
  if (!/^\d{6}$/.test(code) || !profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`Invalid company profile entry: ${code}`);
  }
  return { ...profile, code };
}

async function getJson(key) {
  const response = await fetch(`${valueBase()}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`KV GET ${key} failed: ${response.status} ${await response.text()}`);
  return JSON.parse(await response.text());
}

async function putValue(key, value) {
  const response = await fetch(`${valueBase()}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "text/plain; charset=utf-8"
    },
    body: value
  });
  await assertCloudflareResponse(response, `KV PUT ${key}`);
}

async function bulkRequest(method, body) {
  const response = await fetch(`${namespaceBase()}/bulk`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  await assertCloudflareResponse(response, `KV bulk ${method}`);
}

async function assertCloudflareResponse(response, label) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw response in the error below.
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`${label} failed: ${response.status} ${text}`);
  }
}

function namespaceBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
}

function valueBase() {
  return `${namespaceBase()}/values`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
