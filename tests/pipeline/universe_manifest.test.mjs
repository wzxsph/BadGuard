import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

test("publisher accepts only a universe manifest matching the merged snapshot", async () => {
  const bundle = await writeBundle();
  const output = execFileSync(process.execPath, [
    "scripts/publish_history.mjs",
    "--manifest", bundle.manifestPath,
    "--calendar", bundle.calendarPath,
    "--universe-manifest", bundle.universePath,
    "--validate-only"
  ], { cwd: process.cwd(), encoding: "utf8" });

  expect(JSON.parse(output).universeManifestRevision).toBe(bundle.revision);
  expect(() => execFileSync(process.execPath, [
    "scripts/publish_history.mjs",
    "--manifest", bundle.manifestPath,
    "--calendar", bundle.calendarPath,
    "--validate-only"
  ], { cwd: process.cwd(), stdio: "pipe" })).toThrow();
});

test("publisher rejects a tampered universe member even if the declared revision is unchanged", async () => {
  const bundle = await writeBundle();
  const universe = JSON.parse(await fs.readFile(bundle.universePath, "utf8"));
  universe.members[0].name = "篡改";
  await fs.writeFile(bundle.universePath, JSON.stringify(universe), "utf8");

  expect(() => execFileSync(process.execPath, [
    "scripts/publish_history.mjs",
    "--manifest", bundle.manifestPath,
    "--calendar", bundle.calendarPath,
    "--universe-manifest", bundle.universePath,
    "--validate-only"
  ], { cwd: process.cwd(), stdio: "pipe" })).toThrow();
});

test("publisher writes immutable universe, commits its index pointer, verifies, then repairs the alias", async () => {
  const source = await fs.readFile("scripts/publish_history.mjs", "utf8");
  const immutableWrite = source.indexOf("await kv.put(universePublication.key, universePublication.text)");
  const indexCommit = source.indexOf('await kv.put("signal-history-index", JSON.stringify(nextIndex))');
  const remoteVerification = source.indexOf("await verifyRemotePublication(kv, bundle, published, skippedPayloads, latestLive)");
  const aliasRepair = source.indexOf('await kv.put("signal-universe-manifest", universePublication.text)');

  expect(immutableWrite).toBeGreaterThan(0);
  expect(indexCommit).toBeGreaterThan(immutableWrite);
  expect(remoteVerification).toBeGreaterThan(indexCommit);
  expect(aliasRepair).toBeGreaterThan(remoteVerification);
});

async function writeBundle() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "badguard-universe-"));
  temporaryDirectories.push(directory);
  const snapshotPath = path.join(directory, "history-snapshot-2026-07-08.json");
  const closePath = path.join(directory, "market-close-2026-07-08.json");
  const calendarPath = path.join(directory, "calendar.json");
  const manifestPath = path.join(directory, "manifest.json");
  const universePath = path.join(directory, "universe.json");
  const members = [{
    code: "000001",
    name: "测试",
    industry: "银行",
    status: "active",
    firstSeenAt: "2026-07-08T16:00:00+08:00"
  }];
  const revision = createHash("sha256")
    .update(canonicalJson({ version: 1, source: "code-list", members }))
    .digest("hex")
    .slice(0, 16);
  const universe = {
    version: 1,
    generatedAt: "2026-07-08T16:00:00+08:00",
    source: "code-list",
    previousRevision: null,
    memberCount: 1,
    activeCount: 1,
    staleCount: 0,
    members,
    delta: {
      bootstrap: true,
      candidateCount: 1,
      addedCodes: [],
      newlyMissingCodes: [],
      stillStaleCodes: [],
      reactivatedCodes: [],
      renamedCodes: [],
      addedRate: 0,
      missingRate: 0,
      memberDenominator: 1,
      activeDenominator: 1,
      maximumDeltaRate: 0.01
    },
    revision
  };
  const snapshot = {
    marketDate: "2026-07-08",
    refreshedAt: "2026-07-08T16:05:00+08:00",
    source: "provider",
    sourceLabel: "test",
    meta: {
      scanLimit: 0,
      stockCount: 1,
      universeSource: "code-list",
      historySource: "eastmoney",
      historySuccessCount: 1,
      historySuccessRate: 1,
      failureCount: 0,
      providerMissingCount: 0,
      notListedCount: 0,
      suspendedCount: 0,
      exactCloseCount: 1,
      exactCloseCoverage: 1,
      buildMode: "production",
      perBoardLimit: 0,
      universeManifestRevision: revision,
      universeManifestMemberCount: 1,
      universeStaleCount: 0
    },
    boards: Array.from({ length: 4 }, (_, index) => ({ id: `board-${index}`, rows: [] })),
    topRows: [],
    philosophy: "test",
    disclaimers: []
  };
  const close = {
    marketDate: "2026-07-08",
    closes: { "000001": 10 },
    baselineCloses: {},
    adjustmentBasis: { mode: "qfq", asOf: "2026-07-08" },
    missingCodes: [],
    providerMissingCodes: [],
    notListedCodes: [],
    suspendedCodes: []
  };
  const calendar = { version: 1, tradingDates: ["2026-07-08"] };
  const manifest = {
    version: 1,
    generatedAt: "2026-07-08T16:05:00+08:00",
    source: "live",
    calendarPath,
    contextHash: "test",
    shardCount: 1,
    universeManifestRevision: revision,
    artifacts: [{
      date: "2026-07-08",
      source: "live",
      snapshotPath,
      closePath
    }]
  };
  await Promise.all([
    fs.writeFile(snapshotPath, JSON.stringify(snapshot), "utf8"),
    fs.writeFile(closePath, JSON.stringify(close), "utf8"),
    fs.writeFile(calendarPath, JSON.stringify(calendar), "utf8"),
    fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8"),
    fs.writeFile(universePath, JSON.stringify(universe), "utf8")
  ]);
  return { manifestPath, calendarPath, universePath, revision };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
