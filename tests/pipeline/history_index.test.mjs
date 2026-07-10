import { expect, test } from "vitest";

import {
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
