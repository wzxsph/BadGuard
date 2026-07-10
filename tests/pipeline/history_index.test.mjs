import { expect, test } from "vitest";

import {
  assertSnapshotCompleteness,
  assertStableStockCount,
  isImmutablePayloadPointer,
  mergeHistoryIndex,
  selectLatestLiveArtifact,
  shouldPublishDate
} from "../../scripts/history_index.mjs";

const existing = {
  version: 1,
  tradingDates: ["2026-07-08", "2026-07-09"],
  entries: [
    {
      date: "2026-07-08",
      source: "backfill",
      status: "ready",
      snapshotKey: "history-snapshot:2026-07-08:v:1111111111111111",
      closeKey: "market-close:2026-07-08:v:1111111111111111",
      revision: "1111111111111111"
    }
  ]
};

test("same-day publication is skipped unless force is explicit", () => {
  expect(shouldPublishDate(existing.entries, "2026-07-08", false)).toBe(false);
  expect(shouldPublishDate(existing.entries, "2026-07-08", true)).toBe(true);
  expect(shouldPublishDate(existing.entries, "2026-07-09", false)).toBe(true);
});

test("forced update replaces a date without duplicating the index", () => {
  const replacement = {
    date: "2026-07-08",
    source: "live",
    status: "ready",
    snapshotKey: "history-snapshot:2026-07-08:v:2222222222222222",
    closeKey: "market-close:2026-07-08:v:2222222222222222",
    revision: "2222222222222222"
  };
  const next = mergeHistoryIndex(existing, ["2026-07-08", "2026-07-09"], [replacement], "2026-07-10T00:00:00Z");

  expect(next.entries).toHaveLength(1);
  expect(next.entries[0]).toEqual(replacement);
  expect(next.updatedAt).toBe("2026-07-10T00:00:00Z");
});

test("new dates are sorted newest first and calendar is replaced authoritatively", () => {
  const addition = { date: "2026-07-09", source: "live", status: "ready" };
  const calendar = ["2026-07-08", "2026-07-09", "2026-07-10"];
  const next = mergeHistoryIndex(existing, calendar, [addition], "now");

  expect(next.entries.map((entry) => entry.date)).toEqual(["2026-07-09", "2026-07-08"]);
  expect(next.tradingDates).toEqual(calendar);
});

test("backfill never advances latest and stale live payloads cannot regress it", () => {
  const artifacts = [
    { date: "2026-07-08", source: "backfill" },
    { date: "2026-07-09", source: "backfill" }
  ];
  expect(selectLatestLiveArtifact(artifacts, undefined)).toBeNull();
  expect(selectLatestLiveArtifact([{ date: "2026-07-09", source: "live" }], "2026-07-10")).toBeNull();
  expect(selectLatestLiveArtifact([{ date: "2026-07-10", source: "live" }], "2026-07-10")).toEqual({
    date: "2026-07-10",
    source: "live"
  });
  expect(selectLatestLiveArtifact([
    { date: "2026-07-10", source: "backfill" },
    { date: "2026-07-09", source: "live" }
  ], undefined)).toEqual({ date: "2026-07-09", source: "live" });
});

test("skipped-date repair only trusts immutable date-scoped pointers", () => {
  expect(isImmutablePayloadPointer(
    "history-snapshot:2026-07-08:v:0123456789abcdef",
    "history-snapshot:",
    "2026-07-08"
  )).toBe(true);
  expect(isImmutablePayloadPointer("history-snapshot:2026-07-08", "history-snapshot:", "2026-07-08")).toBe(false);
  expect(isImmutablePayloadPointer(
    "history-snapshot:2026-07-09:v:0123456789abcdef",
    "history-snapshot:",
    "2026-07-08"
  )).toBe(false);
});

test("full production code-list snapshots reject stock-count shrink above five percent", () => {
  const snapshot = (stockCount, overrides = {}) => ({
    meta: {
      buildMode: "production",
      universeSource: "code-list",
      scanLimit: 0,
      stockCount,
      ...overrides
    }
  });

  expect(assertStableStockCount(snapshot(1000), snapshot(950))).toEqual({ checked: true, shrinkRate: 0.05 });
  expect(() => assertStableStockCount(snapshot(1000), snapshot(949))).toThrow(/exceeding 5%/);
  expect(assertStableStockCount(snapshot(1000), snapshot(500, { buildMode: "staging" }))).toEqual({
    checked: false,
    shrinkRate: null
  });
  expect(assertStableStockCount(snapshot(1000), snapshot(500, { universeSource: "realtime" }))).toEqual({
    checked: false,
    shrinkRate: null
  });
});

test("snapshot and close-table completeness requires matching counts at ninety percent", () => {
  const snapshot = {
    meta: {
      stockCount: 100,
      historySuccessCount: 90,
      historySuccessRate: 0.9,
      failureCount: 10,
      exactCloseCount: 90,
      exactCloseCoverage: 0.9
    }
  };
  const close = { closes: Object.fromEntries(Array.from({ length: 90 }, (_, index) => [String(index).padStart(6, "0"), 10])) };

  expect(assertSnapshotCompleteness(snapshot, close)).toMatchObject({
    stockCount: 100,
    historySuccessCount: 90,
    exactCloseCount: 90
  });
  expect(() => assertSnapshotCompleteness(
    { ...snapshot, meta: { ...snapshot.meta, historySuccessCount: 89, historySuccessRate: 0.89, failureCount: 11 } },
    close
  )).toThrow(/at least 90%/);
  expect(() => assertSnapshotCompleteness(snapshot, { closes: { ...close.closes, "999999": 10 } })).toThrow(/counts do not match/);
  expect(() => assertSnapshotCompleteness(
    { ...snapshot, meta: { ...snapshot.meta, buildMode: "production", perBoardLimit: 80 } },
    close
  )).toThrow(/retain all board rows/);
});
