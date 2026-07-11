import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  BOOTSTRAP_COVERAGE_SCOPE,
  BOOTSTRAP_MARKET_DATE,
  createBootstrapSeed,
  writeBootstrapSeed
} from "../../scripts/build_history_seed.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

test("repository snapshot creates only an honest live 2026-07-09 ranked-code seed", async () => {
  const snapshot = await loadBootstrapFixture();
  const seed = createBootstrapSeed(snapshot);
  const rankedRows = snapshot.boards.flatMap((board) => board.rows);
  const uniqueCodes = [...new Set(rankedRows.map((row) => row.code))];

  expect(seed.date).toBe(BOOTSTRAP_MARKET_DATE);
  expect(seed.source).toBe("live");
  expect(seed.rankedRowCount).toBe(rankedRows.length);
  expect(seed.rankedCodeCount).toBe(uniqueCodes.length);
  expect(seed.closeTable.coverageScope).toBe(BOOTSTRAP_COVERAGE_SCOPE);
  expect(seed.closeTable.baselineCloses).toEqual({ "2026-07-08": {} });
  expect(seed.calendar.tradingDates).toContain("2026-07-08");
  expect(seed.snapshot.marketDate).toBe("2026-07-09");
  expect(seed.snapshot.meta.bootstrapSeed).toBe(true);

  for (const row of rankedRows) {
    expect(seed.closeTable.closes[row.code]).toBe(row.triggerClose);
  }
});

test("seed generation rejects stale rows instead of inventing entry-day closes", async () => {
  const snapshot = await loadBootstrapFixture();
  snapshot.boards[0].rows[0].triggerDate = "2026-07-08";

  expect(() => createBootstrapSeed(snapshot)).toThrow(/not an exact 2026-07-09 close/);
});

test("generated seed passes the explicit publisher validation and contains no 7/8 snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "badguard-history-seed-"));
  temporaryDirectories.push(directory);
  const artifactDir = path.join(directory, "publish");
  const calendarPath = path.join(directory, "calendar.json");
  const inputPath = path.join(directory, "bootstrap-input.json");
  await fs.writeFile(inputPath, JSON.stringify(await loadBootstrapFixture()), "utf8");
  const result = await writeBootstrapSeed({
    input: inputPath,
    artifactDir,
    calendarOutput: calendarPath
  });

  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  expect(manifest.bootstrapSeed).toBe(true);
  expect(manifest.artifacts.map((artifact) => artifact.date)).toEqual(["2026-07-09"]);
  await expect(fs.access(path.join(artifactDir, "history-snapshot-2026-07-08.json"))).rejects.toThrow();

  const output = execFileSync(process.execPath, [
    "scripts/publish_history.mjs",
    "--manifest", result.manifestPath,
    "--calendar", calendarPath,
    "--bootstrap-seed",
    "--validate-only"
  ], { cwd: process.cwd(), encoding: "utf8" });
  expect(JSON.parse(output)).toMatchObject({
    bootstrapSeed: true,
    artifacts: [{ date: "2026-07-09", source: "live", closes: result.rankedCodeCount }]
  });

  expect(() => execFileSync(process.execPath, [
    "scripts/publish_history.mjs",
    "--manifest", result.manifestPath,
    "--calendar", calendarPath,
    "--validate-only"
  ], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" })).toThrow();
});

async function loadBootstrapFixture() {
  const snapshot = JSON.parse(await fs.readFile("data/latest.json", "utf8"));
  snapshot.marketDate = BOOTSTRAP_MARKET_DATE;
  snapshot.refreshedAt = "2026-07-09T15:30:00+08:00";
  for (const row of [
    ...snapshot.boards.flatMap((board) => board.rows),
    ...snapshot.topRows
  ]) {
    row.triggerDate = BOOTSTRAP_MARKET_DATE;
  }
  return snapshot;
}
