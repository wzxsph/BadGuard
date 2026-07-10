#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_MARKET_DATE = "2026-07-09";
// Verified exchange dates around the seed. Only 2026-07-09 receives a snapshot;
// the other dates exist solely so T+1/T+2 keep their true exchange-day meaning.
export const BOOTSTRAP_TRADING_DATES = [
  "2026-07-08",
  "2026-07-09",
  "2026-07-10",
  "2026-07-13"
];
export const BOOTSTRAP_COVERAGE_SCOPE = "ranked-codes-only";

export function createBootstrapSeed(snapshot, sourcePath = "data/latest.json") {
  assertBootstrapSnapshot(snapshot);

  const clonedSnapshot = structuredClone(snapshot);
  const closes = {};
  let rankedRowCount = 0;

  for (const board of clonedSnapshot.boards) {
    for (const row of board.rows) {
      rankedRowCount += 1;
      const existing = closes[row.code];
      if (existing !== undefined && existing !== row.triggerClose) {
        throw new Error(`Ranked code ${row.code} has conflicting trigger closes.`);
      }
      closes[row.code] = row.triggerClose;
    }
  }

  const rankedCodeCount = Object.keys(closes).length;
  if (rankedCodeCount === 0) {
    throw new Error("The bundled snapshot has no ranked rows to seed.");
  }

  clonedSnapshot.meta = {
    ...clonedSnapshot.meta,
    bootstrapSeed: true,
    bootstrapSeedSource: sourcePath,
    bootstrapCloseCoverage: BOOTSTRAP_COVERAGE_SCOPE,
    bootstrapRankedRowCount: rankedRowCount,
    bootstrapPublishedCloseCount: rankedCodeCount
  };

  const closeTable = {
    marketDate: BOOTSTRAP_MARKET_DATE,
    closes,
    // 2026-07-08 is an exchange baseline date, but the repository snapshot
    // contains no trustworthy per-stock closes for it. Keep the date explicit
    // and the value map empty instead of carrying prices backward or inventing them.
    baselineCloses: {
      "2026-07-08": {}
    },
    adjustmentBasis: {
      mode: "qfq",
      asOf: BOOTSTRAP_MARKET_DATE
    },
    updatedAt: clonedSnapshot.refreshedAt,
    adjust: "qfq",
    bootstrapSeed: true,
    bootstrapSeedSource: sourcePath,
    coverageScope: BOOTSTRAP_COVERAGE_SCOPE,
    rankedRowCount,
    rankedCodeCount
  };

  const calendar = {
    version: 1,
    tradingDates: [...BOOTSTRAP_TRADING_DATES],
    bootstrapSeed: true
  };

  return {
    date: BOOTSTRAP_MARKET_DATE,
    source: "live",
    snapshot: clonedSnapshot,
    closeTable,
    calendar,
    rankedRowCount,
    rankedCodeCount
  };
}

export async function writeBootstrapSeed({
  input = "data/latest.json",
  artifactDir = "data/publish",
  calendarOutput = "data/trading-calendar.json"
} = {}) {
  const snapshot = parseJson(await fs.readFile(input, "utf8"), input);
  const sourcePath = normalizeRepositoryPath(input);
  const seed = createBootstrapSeed(snapshot, sourcePath);
  const snapshotPath = path.join(artifactDir, `history-snapshot-${seed.date}.json`);
  const closePath = path.join(artifactDir, `market-close-${seed.date}.json`);
  const manifestPath = path.join(artifactDir, "manifest.json");
  const manifest = {
    version: 1,
    generatedAt: seed.snapshot.refreshedAt,
    source: "live",
    bootstrapSeed: true,
    calendarPath: calendarOutput,
    artifacts: [{
      date: seed.date,
      source: "live",
      bootstrapSeed: true,
      snapshotPath,
      closePath
    }]
  };

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(path.dirname(path.resolve(calendarOutput)), { recursive: true });
  await Promise.all([
    writeJson(snapshotPath, seed.snapshot),
    writeJson(closePath, seed.closeTable),
    writeJson(calendarOutput, seed.calendar),
    writeJson(manifestPath, manifest)
  ]);

  return {
    ...seed,
    snapshotPath,
    closePath,
    calendarPath: calendarOutput,
    manifestPath
  };
}

function assertBootstrapSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Bootstrap input must be a signal snapshot object.");
  }
  if (snapshot.marketDate !== BOOTSTRAP_MARKET_DATE) {
    throw new Error(`Bootstrap input must be the verified ${BOOTSTRAP_MARKET_DATE} snapshot.`);
  }
  if (snapshot.source !== "provider" || snapshot.meta?.snapshotSource !== "live") {
    throw new Error("Bootstrap input must be an honestly labelled live provider snapshot.");
  }
  if (!Number.isFinite(Date.parse(snapshot.refreshedAt))) {
    throw new Error("Bootstrap input has an invalid refreshedAt timestamp.");
  }
  if (!Array.isArray(snapshot.boards) || snapshot.boards.length !== 4 || !Array.isArray(snapshot.topRows)) {
    throw new Error("Bootstrap input must contain all four boards and topRows.");
  }

  const expectedBoards = ["low-rebound", "trend-strength", "oversold-repair", "risk-filter"];
  if (JSON.stringify(snapshot.boards.map((board) => board.id)) !== JSON.stringify(expectedBoards)) {
    throw new Error("Bootstrap input has an unexpected board set or ordering.");
  }

  for (const board of snapshot.boards) {
    if (!Array.isArray(board.rows)) {
      throw new Error(`Bootstrap board ${board.id} has invalid rows.`);
    }
    for (const row of board.rows) {
      assertBootstrapRow(row, board.id);
    }
  }
}

function assertBootstrapRow(row, boardId) {
  if (!row || typeof row !== "object" || !/^\d{6}$/.test(String(row.code))) {
    throw new Error(`Bootstrap board ${boardId} contains an invalid stock row.`);
  }
  if (row.triggerDate !== BOOTSTRAP_MARKET_DATE || !isPositiveNumber(row.triggerClose)) {
    throw new Error(`Bootstrap row ${row.code} is not an exact ${BOOTSTRAP_MARKET_DATE} close.`);
  }
  if (
    !isNonNegativeNumber(row.amount) ||
    !isOptionalNonNegativeNumber(row.turnoverRate) ||
    !isOptionalNonNegativeNumber(row.floatMarketCap) ||
    typeof row.liquidityEligible !== "boolean" ||
    !Array.isArray(row.liquidityTags) ||
    !row.liquidityTags.every((tag) => typeof tag === "string")
  ) {
    throw new Error(`Bootstrap row ${row.code} has incomplete liquidity fields.`);
  }
  if (
    boardId !== "risk-filter" &&
    (row.liquidityEligible !== true || row.amount < 200_000_000 || row.floatMarketCap < 5_000_000_000)
  ) {
    throw new Error(`Bootstrap observation row ${row.code} violates the liquidity gate.`);
  }
}

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function normalizeRepositoryPath(value) {
  const relative = path.relative(process.cwd(), path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(value);
  }
  return relative.split(path.sep).join("/");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`);
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value) {
  return value === null || isNonNegativeNumber(value);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const args = parseArgs(process.argv.slice(2));
  const result = await writeBootstrapSeed({
    input: args.input,
    artifactDir: args["artifact-dir"],
    calendarOutput: args.calendar
  });
  console.log(JSON.stringify({
    mode: "bootstrap-seed",
    date: result.date,
    source: result.source,
    rankedRows: result.rankedRowCount,
    rankedCodes: result.rankedCodeCount,
    manifest: result.manifestPath
  }, null, 2));
}
