#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  assertSnapshotCompleteness,
  assertStableStockCount,
  isImmutablePayloadPointer,
  mergeHistoryIndex,
  selectLatestLiveArtifact,
  shouldPublishDate
} from "./history_index.mjs";

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || "data/publish/manifest.json";
const calendarPath = args.calendar || "data/trading-calendar.json";
const universeManifestPath = args["universe-manifest"];
const validateOnly = Boolean(args["validate-only"]);
const force = Boolean(args.force) || process.env.FORCE_PUBLISH === "true";
const production = process.env.PUBLISH_PRODUCTION === "true";
const bootstrapSeed = Boolean(args["bootstrap-seed"]);

const bundle = await loadAndValidateBundle(manifestPath, calendarPath, bootstrapSeed);
const universe = universeManifestPath
  ? await loadAndValidateUniverseManifest(universeManifestPath)
  : null;
validateBundleUniverse(bundle, universe, bootstrapSeed);
if (validateOnly) {
  console.log(JSON.stringify({
    ...bundle.summary,
    universeManifestRevision: universe?.manifest.revision ?? null
  }, null, 2));
  process.exit(0);
}

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const namespaceId = requiredEnv("KV_NAMESPACE_ID");
const kv = createKvClient(accountId, apiToken, namespaceId);

if (!production) {
  if (bootstrapSeed) {
    throw new Error("Bootstrap seed publication is production-only.");
  }
  const latest = [...bundle.artifacts].sort((left, right) => right.date.localeCompare(left.date))[0];
  await kv.put("staging-signal-snapshot", latest.snapshotText);
  const stored = parseJson(await kv.get("staging-signal-snapshot"), "staging-signal-snapshot");
  if (stored.marketDate !== latest.date || stored.meta?.buildMode !== "staging") {
    throw new Error("Staging snapshot verification failed.");
  }
  console.log(JSON.stringify({ mode: "staging", date: latest.date, key: "staging-signal-snapshot" }, null, 2));
  process.exit(0);
}

const existingIndexText = await kv.get("signal-history-index");
const existingIndex = existingIndexText
  ? validateExistingIndex(parseJson(existingIndexText, "signal-history-index"))
  : { version: 1, tradingDates: [], entries: [] };
if (bootstrapSeed) {
  const targetDate = bundle.artifacts[0].date;
  const existingTarget = existingIndex.entries.find((entry) => entry.date === targetDate && entry.status === "ready");
  if (existingTarget) {
    await readImmutableEntryPayload(kv, existingTarget, targetDate);
    console.log(JSON.stringify({
      mode: "production-bootstrap-seed",
      published: [],
      skipped: [targetDate],
      reason: "history date already has an immutable ready entry"
    }, null, 2));
    process.exit(0);
  }
  if (existingIndex.entries.length > 0) {
    throw new Error("Bootstrap seed is only allowed for an empty history index.");
  }
}
const existingLatestText = await kv.get("latest-signal-snapshot");
const existingLatest = existingLatestText ? parseJson(existingLatestText, "latest-signal-snapshot") : null;
if (existingLatest && !isDate(existingLatest.marketDate)) {
  throw new Error("Existing latest-signal-snapshot has an invalid marketDate.");
}
await enforceLiveStockCountStability(kv, existingIndex, bundle.artifacts, force, bootstrapSeed);
const universePublication = universe && !bootstrapSeed
  ? {
      ...universe,
      key: `signal-universe-manifest:v:${universe.manifest.revision}`
    }
  : null;
const published = [];
const skipped = [];
const skippedPayloads = [];
const replacementCalendarDates = new Set(bundle.calendar.tradingDates);
for (const entry of existingIndex.entries) {
  if (!replacementCalendarDates.has(entry.date)) {
    throw new Error(`Retained history entry ${entry.date} is absent from the replacement exchange calendar.`);
  }
}

// Immutable payloads are prepared first. The index commits visibility; compatibility aliases follow it.
if (universePublication) {
  await kv.put(universePublication.key, universePublication.text);
}
await kv.put("market-trading-calendar", JSON.stringify(bundle.calendar));

for (const artifact of [...bundle.artifacts].sort((left, right) => left.date.localeCompare(right.date))) {
  if (!shouldPublishDate(existingIndex.entries, artifact.date, force, { replaceBootstrap: !bootstrapSeed })) {
    skipped.push(artifact.date);
    const indexedEntry = existingIndex.entries.find((entry) => entry.date === artifact.date);
    skippedPayloads.push(await readImmutableEntryPayload(kv, indexedEntry, artifact.date));
    continue;
  }

  const revision = createHash("sha256")
    .update(artifact.snapshotText)
    .update("\n")
    .update(artifact.closeText)
    .digest("hex")
    .slice(0, 16);
  const snapshotKey = `history-snapshot:${artifact.date}:v:${revision}`;
  const closeKey = `market-close:${artifact.date}:v:${revision}`;

  await kv.put(snapshotKey, artifact.snapshotText);
  await kv.put(closeKey, artifact.closeText);

  const entry = {
    date: artifact.date,
    source: artifact.source,
    status: "ready",
    publishedAt: new Date().toISOString(),
    snapshotKey,
    closeKey,
    revision,
    ...(universePublication ? {
      universeManifestKey: universePublication.key,
      universeManifestRevision: universePublication.manifest.revision
    } : {}),
    ...(artifact.bootstrapSeed === true ? { bootstrapSeed: true } : {})
  };
  published.push({ ...artifact, ...entry });
}

const nextIndex = mergeHistoryIndex(
  existingIndex,
  bundle.calendar.tradingDates,
  published.map(({ snapshotText, closeText, snapshot, close, snapshotPath, closePath, ...entry }) => entry),
  new Date().toISOString()
);
assertUniqueDates(nextIndex.entries);
const replacementCalendar = new Set(nextIndex.tradingDates);
for (const entry of nextIndex.entries) {
  if (!replacementCalendar.has(entry.date)) {
    throw new Error(`History entry ${entry.date} is absent from the replacement exchange calendar.`);
  }
}
await kv.put("signal-history-index", JSON.stringify(nextIndex));

for (const artifact of published) {
  await kv.put(`history-snapshot:${artifact.date}`, artifact.snapshotText);
  await kv.put(`market-close:${artifact.date}`, artifact.closeText);
  await kv.put(`signal-snapshot:${artifact.date}`, artifact.snapshotText);
}

for (const payload of skippedPayloads) {
  await kv.put(`history-snapshot:${payload.date}`, payload.snapshotText);
  await kv.put(`market-close:${payload.date}`, payload.closeText);
  await kv.put(`signal-snapshot:${payload.date}`, payload.snapshotText);
}

const latestLiveEntry = bootstrapSeed && existingLatest
  ? null
  : selectLatestLiveArtifact(nextIndex.entries, existingLatest?.marketDate);
let latestLive = null;
if (latestLiveEntry) {
  const snapshotKey = latestLiveEntry.snapshotKey ?? `history-snapshot:${latestLiveEntry.date}`;
  const snapshotText = await kv.get(snapshotKey);
  const snapshot = parseJson(snapshotText, snapshotKey);
  if (snapshot.marketDate !== latestLiveEntry.date) {
    throw new Error(`Indexed live snapshot ${snapshotKey} has the wrong market date.`);
  }
  await kv.put("latest-signal-snapshot", snapshotText);
  latestLive = { date: latestLiveEntry.date, snapshotText };
}

await verifyRemotePublication(kv, bundle, published, skippedPayloads, latestLive);
const universeAcceptedByIndex = universePublication && nextIndex.entries.some((entry) =>
  entry.universeManifestKey === universePublication.key &&
  entry.universeManifestRevision === universePublication.manifest.revision
);
if (universePublication && universeAcceptedByIndex) {
  await kv.put("signal-universe-manifest", universePublication.text);
  const acceptedUniverse = parseJson(await kv.get("signal-universe-manifest"), "signal-universe-manifest");
  if (acceptedUniverse.revision !== universePublication.manifest.revision) {
    throw new Error("Accepted universe manifest alias verification failed.");
  }
}
console.log(JSON.stringify({
  mode: bootstrapSeed ? "production-bootstrap-seed" : "production",
  force,
  published: published.map((entry) => ({ date: entry.date, revision: entry.revision })),
  skipped,
  indexEntries: nextIndex.entries.length,
  universeManifestRevision: universePublication?.manifest.revision ?? null
}, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

async function loadAndValidateBundle(manifestFile, calendarFile, bootstrapSeedMode = false) {
  const manifest = parseJson(await fs.readFile(manifestFile, "utf8"), manifestFile);
  const calendar = parseJson(await fs.readFile(calendarFile, "utf8"), calendarFile);
  if (manifest.version !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("Manifest must be version 1 with at least one artifact.");
  }
  if ((manifest.bootstrapSeed === true) !== bootstrapSeedMode) {
    throw new Error("Bootstrap seed manifest requires an explicit --bootstrap-seed publication flag.");
  }
  if (bootstrapSeedMode) {
    if (
      manifest.artifacts.length !== 1 ||
      manifest.artifacts[0]?.date !== "2026-07-09" ||
      manifest.artifacts[0]?.source !== "live" ||
      manifest.artifacts[0]?.bootstrapSeed !== true ||
      calendar.bootstrapSeed !== true
    ) {
      throw new Error("Bootstrap seed must contain only the verified live 2026-07-09 artifact.");
    }
  }
  if (calendar.version !== 1 || !Array.isArray(calendar.tradingDates)) {
    throw new Error("Calendar must be { version: 1, tradingDates: string[] }.");
  }
  assertDateList(calendar.tradingDates, "calendar.tradingDates");
  const calendarDates = new Set(calendar.tradingDates);
  const artifacts = [];

  for (const descriptor of manifest.artifacts) {
    if (!isDate(descriptor.date) || !["live", "backfill"].includes(descriptor.source)) {
      throw new Error(`Invalid manifest artifact descriptor: ${JSON.stringify(descriptor)}`);
    }
    if (!calendarDates.has(descriptor.date)) {
      throw new Error(`Artifact date ${descriptor.date} is missing from the exchange calendar.`);
    }
    const snapshotText = await fs.readFile(descriptor.snapshotPath, "utf8");
    const closeText = await fs.readFile(descriptor.closePath, "utf8");
    const snapshot = parseJson(snapshotText, descriptor.snapshotPath);
    const close = parseJson(closeText, descriptor.closePath);
    validateSnapshot(snapshot, descriptor.date);
    const targetIndex = calendar.tradingDates.indexOf(descriptor.date);
    const expectedBaselineDates = calendar.tradingDates.slice(Math.max(0, targetIndex - 2), targetIndex);
    validateCloseTable(close, descriptor.date, expectedBaselineDates, bootstrapSeedMode);
    validateDataCompleteness(snapshot, close, descriptor.date, bootstrapSeedMode);
    for (const board of snapshot.boards) {
      for (const row of board.rows) {
        if (!(row.code in close.closes)) {
          throw new Error(`${descriptor.date} close table is missing ranked code ${row.code}.`);
        }
        if (Number(row.triggerClose) !== Number(close.closes[row.code])) {
          throw new Error(`${descriptor.date} triggerClose does not match close table for ${row.code}.`);
        }
      }
    }
    artifacts.push({ ...descriptor, snapshotText, closeText, snapshot, close });
  }
  assertUniqueDates(artifacts);
  return {
    manifest,
    calendar,
    artifacts,
    summary: {
      artifacts: artifacts.map((artifact) => ({
        date: artifact.date,
        source: artifact.source,
        closes: Object.keys(artifact.close.closes).length,
        boards: artifact.snapshot.boards.map((board) => [board.id, board.rows.length])
      })),
      tradingDates: calendar.tradingDates.length,
      bootstrapSeed: bootstrapSeedMode
    }
  };
}

async function loadAndValidateUniverseManifest(file) {
  const text = await fs.readFile(file, "utf8");
  const manifest = parseJson(text, file);
  if (
    manifest.version !== 1 ||
    typeof manifest.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !["code-list", "realtime"].includes(manifest.source) ||
    !isRevision(manifest.revision) ||
    (manifest.previousRevision !== null && !isRevision(manifest.previousRevision)) ||
    !Array.isArray(manifest.members) ||
    manifest.members.length === 0
  ) {
    throw new Error("Universe manifest has invalid version or metadata.");
  }
  const expectedRevision = createHash("sha256")
    .update(canonicalJson({ version: manifest.version, source: manifest.source, members: manifest.members }))
    .digest("hex")
    .slice(0, 16);
  if (manifest.revision !== expectedRevision) {
    throw new Error("Universe manifest revision does not match its members.");
  }
  let activeCount = 0;
  const codes = [];
  for (const member of manifest.members) {
    if (
      !member ||
      !/^\d{6}$/.test(member.code) ||
      typeof member.name !== "string" ||
      !member.name.trim() ||
      typeof member.industry !== "string" ||
      !["active", "stale"].includes(member.status) ||
      typeof member.firstSeenAt !== "string" ||
      !Number.isFinite(Date.parse(member.firstSeenAt)) ||
      (member.status === "stale" && (
        typeof member.staleSinceAt !== "string" || !Number.isFinite(Date.parse(member.staleSinceAt))
      )) ||
      (member.status === "active" && member.staleSinceAt !== undefined)
    ) {
      throw new Error(`Universe manifest contains an invalid member: ${JSON.stringify(member)}.`);
    }
    codes.push(member.code);
    activeCount += Number(member.status === "active");
  }
  if (
    JSON.stringify(codes) !== JSON.stringify([...codes].sort()) ||
    new Set(codes).size !== codes.length ||
    manifest.memberCount !== codes.length ||
    manifest.activeCount !== activeCount ||
    manifest.staleCount !== codes.length - activeCount
  ) {
    throw new Error("Universe manifest member ordering or counts are inconsistent.");
  }
  validateUniverseDelta(manifest.delta);
  return { manifest, text };
}

function validateBundleUniverse(bundle, universe, bootstrapSeedMode) {
  const revision = bundle.manifest.universeManifestRevision;
  if (bootstrapSeedMode) {
    if (universe || revision !== undefined) {
      throw new Error("Bootstrap seed publication cannot accept a universe manifest.");
    }
    return;
  }
  if (revision === undefined && !universe) {
    if (bundle.artifacts.some((artifact) => artifact.snapshot.meta?.buildMode === "production")) {
      throw new Error("Production history publication requires an accepted universe manifest.");
    }
    return;
  }
  if (!universe || revision !== universe.manifest.revision) {
    throw new Error("History bundle and universe manifest revisions do not match.");
  }
  for (const artifact of bundle.artifacts) {
    if (
      artifact.snapshot.meta?.universeManifestRevision !== universe.manifest.revision ||
      artifact.snapshot.meta?.universeManifestMemberCount !== universe.manifest.memberCount ||
      artifact.snapshot.meta?.universeStaleCount !== universe.manifest.staleCount
    ) {
      throw new Error(`Snapshot ${artifact.date} does not match the universe manifest.`);
    }
  }
}

function validateUniverseDelta(delta) {
  const listFields = ["addedCodes", "newlyMissingCodes", "stillStaleCodes", "reactivatedCodes", "renamedCodes"];
  if (
    !delta ||
    typeof delta.bootstrap !== "boolean" ||
    !Number.isInteger(delta.candidateCount) ||
    delta.candidateCount <= 0 ||
    !Number.isInteger(delta.memberDenominator) ||
    delta.memberDenominator <= 0 ||
    !Number.isInteger(delta.activeDenominator) ||
    delta.activeDenominator <= 0 ||
    !Number.isFinite(delta.maximumDeltaRate) ||
    delta.maximumDeltaRate < 0 ||
    delta.maximumDeltaRate > 1 ||
    !Number.isFinite(delta.addedRate) ||
    !Number.isFinite(delta.missingRate) ||
    listFields.some((field) => !Array.isArray(delta[field]) || delta[field].some((code) => !/^\d{6}$/.test(code)))
  ) {
    throw new Error("Universe manifest delta is malformed.");
  }
  const expectedAddedRate = delta.bootstrap ? 0 : delta.addedCodes.length / delta.memberDenominator;
  const expectedMissingRate = delta.bootstrap ? 0 : delta.newlyMissingCodes.length / delta.activeDenominator;
  if (
    Math.abs(delta.addedRate - expectedAddedRate) > 0.00000001 ||
    Math.abs(delta.missingRate - expectedMissingRate) > 0.00000001 ||
    delta.addedRate > delta.maximumDeltaRate + Number.EPSILON ||
    delta.missingRate > delta.maximumDeltaRate + Number.EPSILON
  ) {
    throw new Error("Universe manifest delta exceeds its accepted threshold or has inconsistent rates.");
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateSnapshot(snapshot, date) {
  if (snapshot.marketDate !== date || snapshot.source !== "provider") {
    throw new Error(`Snapshot ${date} has mismatched marketDate/source.`);
  }
  if (!Array.isArray(snapshot.boards) || snapshot.boards.length !== 4 || !Array.isArray(snapshot.topRows)) {
    throw new Error(`Snapshot ${date} must contain four boards and topRows.`);
  }
  for (const board of snapshot.boards) {
    if (!Array.isArray(board.rows)) {
      throw new Error(`Snapshot ${date} board ${board.id} has invalid rows.`);
    }
    assertSorted(board.rows, `${date}/${board.id}`);
    for (const row of board.rows) {
      if (row.triggerDate !== date || !Number.isFinite(row.triggerClose) || row.triggerClose <= 0) {
        throw new Error(`${date}/${row.code} has invalid trigger date/close.`);
      }
      if (
        !Number.isFinite(row.amount) ||
        row.amount < 0 ||
        !isOptionalNonNegativeNumber(row.turnoverRate) ||
        !isOptionalNonNegativeNumber(row.floatMarketCap) ||
        typeof row.liquidityEligible !== "boolean" ||
        !Array.isArray(row.liquidityTags) ||
        !row.liquidityTags.every((tag) => typeof tag === "string")
      ) {
        throw new Error(`${date}/${row.code} has malformed liquidity fields.`);
      }
      if (row.signalId !== "risk-filter") {
        if (row.liquidityEligible !== true || row.amount < 200_000_000 || row.floatMarketCap < 5_000_000_000) {
          throw new Error(`${date}/${row.code} observation row violates the liquidity gate.`);
        }
      }
    }
  }
  if (snapshot.topRows.some((row) => row.signalId === "risk-filter")) {
    throw new Error(`Snapshot ${date} topRows contains a risk row.`);
  }
  assertSorted(snapshot.topRows, `${date}/topRows`);
}

function validateCloseTable(close, date, expectedBaselineDates, bootstrapSeedMode = false) {
  if (close.marketDate !== date || !close.closes || Array.isArray(close.closes) || typeof close.closes !== "object") {
    throw new Error(`Close table ${date} must be { marketDate, closes }.`);
  }
  validateCloseMap(close.closes, `${date} closes`);
  if (!close.baselineCloses || Array.isArray(close.baselineCloses) || typeof close.baselineCloses !== "object") {
    throw new Error(`Close table ${date} must include baselineCloses.`);
  }
  const baselineDates = Object.keys(close.baselineCloses).sort();
  if (JSON.stringify(baselineDates) !== JSON.stringify(expectedBaselineDates)) {
    throw new Error(`Close table ${date} baseline dates do not match the prior two exchange dates.`);
  }
  for (const baselineDate of baselineDates) {
    const values = close.baselineCloses[baselineDate];
    if (!values || Array.isArray(values) || typeof values !== "object") {
      throw new Error(`Close table ${date} has an invalid baseline map for ${baselineDate}.`);
    }
    validateCloseMap(values, `${date} baseline ${baselineDate}`);
  }
  const basis = close.adjustmentBasis;
  if (
    !basis ||
    !["qfq", "hfq", "none"].includes(basis.mode) ||
    !isDate(basis.asOf) ||
    basis.asOf < date
  ) {
    throw new Error(`Close table ${date} has an invalid adjustmentBasis.`);
  }
}

function validateCloseMap(values, label) {
  for (const [code, value] of Object.entries(values)) {
    if (!/^\d{6}$/.test(code) || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} contains invalid ${code}: ${value}.`);
    }
  }
}

function validateDataCompleteness(snapshot, close, date, bootstrapSeedMode = false) {
  if (bootstrapSeedMode) {
    validateBootstrapSeedCompleteness(snapshot, close, date);
    return;
  }

  try {
    assertSnapshotCompleteness(snapshot, close);
  } catch (error) {
    throw new Error(`Snapshot ${date} completeness validation failed: ${error.message}`);
  }
}

function validateBootstrapSeedCompleteness(snapshot, close, date) {
  const rows = snapshot.boards.flatMap((board) => board.rows);
  const rankedCodes = [...new Set(rows.map((row) => row.code))].sort();
  const closeCodes = Object.keys(close.closes).sort();
  const meta = snapshot.meta;
  if (
    date !== "2026-07-09" ||
    snapshot.meta?.snapshotSource !== "live" ||
    meta?.bootstrapSeed !== true ||
    meta.bootstrapCloseCoverage !== "ranked-codes-only" ||
    meta.bootstrapRankedRowCount !== rows.length ||
    meta.bootstrapPublishedCloseCount !== closeCodes.length ||
    close.bootstrapSeed !== true ||
    close.coverageScope !== "ranked-codes-only" ||
    close.rankedRowCount !== rows.length ||
    close.rankedCodeCount !== closeCodes.length ||
    JSON.stringify(Object.keys(close.baselineCloses)) !== JSON.stringify(["2026-07-08"]) ||
    Object.keys(close.baselineCloses["2026-07-08"] || {}).length !== 0 ||
    JSON.stringify(rankedCodes) !== JSON.stringify(closeCodes)
  ) {
    throw new Error(`Bootstrap seed ${date} does not exactly cover its ranked codes.`);
  }
  if (
    !Number.isInteger(meta.stockCount) ||
    meta.stockCount <= 0 ||
    !Number.isInteger(meta.exactCloseCount) ||
    meta.exactCloseCount < closeCodes.length ||
    meta.exactCloseCount > meta.stockCount ||
    !Number.isInteger(meta.failureCount) ||
    meta.failureCount < 0 ||
    meta.failureCount > meta.stockCount
  ) {
    throw new Error(`Bootstrap seed ${date} has inconsistent original coverage metadata.`);
  }
}

function assertSorted(rows, label) {
  const sorted = [...rows].sort(compareRows);
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].code !== sorted[index].code || rows[index].signalStrength !== sorted[index].signalStrength) {
      throw new Error(`${label} is not sorted by strength, float cap, and code.`);
    }
  }
}

function compareRows(left, right) {
  const strength = Number(right.signalStrength) - Number(left.signalStrength);
  if (strength !== 0) return strength;
  const leftCap = Number.isFinite(left.floatMarketCap) ? left.floatMarketCap : -Infinity;
  const rightCap = Number.isFinite(right.floatMarketCap) ? right.floatMarketCap : -Infinity;
  if (leftCap !== rightCap) return rightCap - leftCap;
  return String(left.code).localeCompare(String(right.code));
}

function validateExistingIndex(index) {
  if (index.version !== 1 || !Array.isArray(index.entries) || !Array.isArray(index.tradingDates)) {
    throw new Error("Existing signal-history-index has an unsupported shape.");
  }
  assertDateList(index.tradingDates, "existing index tradingDates");
  const entryByDate = new Map();
  for (const entry of index.entries) {
    if (
      !isDate(entry.date) ||
      !["live", "backfill"].includes(entry.source) ||
      entry.status !== "ready" ||
      (entry.bootstrapSeed !== undefined && typeof entry.bootstrapSeed !== "boolean") ||
      (entry.publishedAt !== undefined && typeof entry.publishedAt !== "string") ||
      (entry.revision !== undefined && !isRevision(entry.revision)) ||
      (entry.universeManifestRevision !== undefined && !isRevision(entry.universeManifestRevision)) ||
      (entry.universeManifestKey !== undefined && !isUniverseManifestKey(
        entry.universeManifestKey,
        entry.universeManifestRevision
      )) ||
      ((entry.universeManifestKey === undefined) !== (entry.universeManifestRevision === undefined)) ||
      (entry.snapshotKey !== undefined && !isPayloadKey(entry.snapshotKey, "history-snapshot:", entry.date)) ||
      (entry.closeKey !== undefined && !isPayloadKey(entry.closeKey, "market-close:", entry.date))
    ) {
      throw new Error(`Existing history entry is invalid: ${JSON.stringify(entry)}`);
    }
    if (!entryByDate.has(entry.date)) entryByDate.set(entry.date, entry);
  }
  return {
    ...index,
    tradingDates: [...index.tradingDates],
    entries: [...entryByDate.values()].sort((left, right) => right.date.localeCompare(left.date))
  };
}

async function enforceLiveStockCountStability(kv, existingIndex, artifacts, force, bootstrapSeedMode = false) {
  const liveCandidates = artifacts
    .filter((artifact) => artifact.source === "live" && (
      force || shouldPublishDate(
        existingIndex.entries,
        artifact.date,
        false,
        { replaceBootstrap: !bootstrapSeedMode }
      )
    ))
    .sort((left, right) => left.date.localeCompare(right.date));

  for (const artifact of liveCandidates) {
    const priorEntry = existingIndex.entries
      .filter((entry) => entry.status === "ready" && entry.date < artifact.date)
      .sort((left, right) => right.date.localeCompare(left.date))[0];
    if (!priorEntry) continue;

    const priorKey = priorEntry.snapshotKey ?? `history-snapshot:${priorEntry.date}`;
    const priorSnapshot = parseJson(await kv.get(priorKey), priorKey);
    if (priorSnapshot.marketDate !== priorEntry.date) {
      throw new Error(`Prior snapshot ${priorKey} has the wrong market date.`);
    }
    assertStableStockCount(priorSnapshot, artifact.snapshot);
  }
}

async function readImmutableEntryPayload(kv, entry, date) {
  if (
    !entry ||
    !isImmutablePayloadPointer(entry.snapshotKey, "history-snapshot:", date) ||
    !isImmutablePayloadPointer(entry.closeKey, "market-close:", date)
  ) {
    throw new Error(`Skipped history date ${date} lacks immutable snapshot/close pointers; force publication is required.`);
  }
  const snapshotText = await kv.get(entry.snapshotKey);
  const closeText = await kv.get(entry.closeKey);
  const snapshot = parseJson(snapshotText, entry.snapshotKey);
  const close = parseJson(closeText, entry.closeKey);
  if (snapshot.marketDate !== date || close.marketDate !== date) {
    throw new Error(`Immutable payload pointers for skipped date ${date} have mismatched market dates.`);
  }
  return {
    date,
    snapshotKey: entry.snapshotKey,
    closeKey: entry.closeKey,
    snapshotText,
    closeText
  };
}

async function verifyRemotePublication(kv, bundle, published, skippedPayloads, latestLive) {
  const calendar = parseJson(await kv.get("market-trading-calendar"), "market-trading-calendar");
  if (
    calendar.version !== 1 ||
    JSON.stringify(calendar.tradingDates) !== JSON.stringify(bundle.calendar.tradingDates)
  ) {
    throw new Error("Remote trading calendar verification failed.");
  }
  const index = validateExistingIndex(parseJson(await kv.get("signal-history-index"), "signal-history-index"));
  const entries = new Map(index.entries.map((entry) => [entry.date, entry]));
  for (const artifact of published) {
    const entry = entries.get(artifact.date);
    if (!entry || entry.revision !== artifact.revision || entry.snapshotKey !== artifact.snapshotKey || entry.closeKey !== artifact.closeKey) {
      throw new Error(`Remote index pointer verification failed for ${artifact.date}.`);
    }
    if (
      artifact.universeManifestKey &&
      (entry.universeManifestKey !== artifact.universeManifestKey ||
        entry.universeManifestRevision !== artifact.universeManifestRevision)
    ) {
      throw new Error(`Remote universe pointer verification failed for ${artifact.date}.`);
    }
    for (const [key, expectedDate] of [
      [entry.snapshotKey, artifact.date],
      [entry.closeKey, artifact.date],
      [`history-snapshot:${artifact.date}`, artifact.date],
      [`market-close:${artifact.date}`, artifact.date],
      [`signal-snapshot:${artifact.date}`, artifact.date]
    ]) {
      const value = parseJson(await kv.get(key), key);
      if ((value.marketDate ?? value.triggerDate) !== expectedDate) {
        throw new Error(`Remote key ${key} has the wrong market date.`);
      }
    }
    if (entry.universeManifestKey) {
      const universe = parseJson(await kv.get(entry.universeManifestKey), entry.universeManifestKey);
      if (universe.revision !== entry.universeManifestRevision) {
        throw new Error(`Remote universe manifest ${entry.universeManifestKey} has the wrong revision.`);
      }
    }
  }
  for (const payload of skippedPayloads) {
    const entry = entries.get(payload.date);
    if (!entry || entry.snapshotKey !== payload.snapshotKey || entry.closeKey !== payload.closeKey) {
      throw new Error(`Skipped date ${payload.date} lost its immutable index pointers.`);
    }
    for (const key of [
      entry.snapshotKey,
      entry.closeKey,
      `history-snapshot:${payload.date}`,
      `market-close:${payload.date}`,
      `signal-snapshot:${payload.date}`
    ]) {
      const value = parseJson(await kv.get(key), key);
      if (value.marketDate !== payload.date) {
        throw new Error(`Repaired key ${key} has the wrong market date.`);
      }
    }
  }
  if (latestLive) {
    const latest = parseJson(await kv.get("latest-signal-snapshot"), "latest-signal-snapshot");
    if (latest.marketDate !== latestLive.date) {
      throw new Error(`latest-signal-snapshot did not advance to live date ${latestLive.date}.`);
    }
  }
}

function createKvClient(accountId, apiToken, namespaceId) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  return {
    async get(key) {
      const response = await fetch(`${base}/${encodeURIComponent(key)}`, { headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`KV GET ${key} failed: ${response.status} ${await response.text()}`);
      return await response.text();
    },
    async put(key, value) {
      const response = await fetch(`${base}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: value
      });
      if (!response.ok) throw new Error(`KV PUT ${key} failed: ${response.status} ${await response.text()}`);
    }
  };
}

function parseJson(text, label) {
  if (typeof text !== "string") throw new Error(`${label} does not exist.`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertDateList(values, label) {
  if (values.some((value) => !isDate(value))) throw new Error(`${label} contains an invalid date.`);
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate dates.`);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) throw new Error(`${label} must be ascending.`);
  }
}

function assertUniqueDates(entries) {
  const dates = entries.map((entry) => entry.date);
  if (new Set(dates).size !== dates.length) throw new Error("History entries contain duplicate dates.");
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

function isOptionalNonNegativeNumber(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function isPayloadKey(value, prefix, date) {
  if (typeof value !== "string") return false;
  const canonical = `${prefix}${date}`;
  return value === canonical || (value.startsWith(`${canonical}:v:`) && isRevision(value.slice(canonical.length + 3)));
}

function isUniverseManifestKey(value, revision) {
  return isRevision(revision) && value === `signal-universe-manifest:v:${revision}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
