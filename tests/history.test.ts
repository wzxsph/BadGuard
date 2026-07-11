import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_INDEX_KEY,
  HISTORY_SNAPSHOT_PREFIX,
  MARKET_CLOSE_PREFIX,
  MARKET_TRADING_CALENDAR_KEY,
  HistoryNotFoundError,
  HistoryStorageUnavailableError,
  InvalidHistoryDateError,
  getHistoryDetail,
  getHistoryIndex,
  isMarketCloseReached,
  isValidHistoryDate,
  listKeysByPrefix,
  normalizeHistoryIndex,
  upsertHistoryIndex,
  type HistoryIndexEntry,
  type SignalHistoryIndex
} from "../src/history";
import type { Env } from "../src/data-source";
import type { SignalRow, SignalSnapshot } from "../src/types";

describe("history storage contract", () => {
  it("validates real ISO calendar dates rather than only their shape", () => {
    expect(isValidHistoryDate("2026-07-08")).toBe(true);
    expect(isValidHistoryDate("2028-02-29")).toBe(true);
    expect(isValidHistoryDate("2026-02-29")).toBe(false);
    expect(isValidHistoryDate("2026-07-8")).toBe(false);
    expect(isValidHistoryDate("2026-07-08/extra")).toBe(false);
  });

  it("deduplicates entries and force-upserts one date without duplicating it", () => {
    const normalized = normalizeHistoryIndex({
      version: 1,
      tradingDates: ["2026-07-09", "2026-07-08", "2026-07-09"],
      entries: [
        readyEntry("2026-07-08", "backfill"),
        readyEntry("2026-07-09", "live"),
        readyEntry("2026-07-08", "live")
      ]
    });

    expect(normalized.tradingDates).toEqual(["2026-07-08", "2026-07-09"]);
    expect(normalized.entries.map((entry) => [entry.date, entry.source])).toEqual([
      ["2026-07-09", "live"],
      ["2026-07-08", "live"]
    ]);

    const updated = upsertHistoryIndex(normalized, readyEntry("2026-07-08", "backfill"));
    expect(updated.entries.filter((entry) => entry.date === "2026-07-08")).toEqual([
      readyEntry("2026-07-08", "backfill")
    ]);
    expect(() => upsertHistoryIndex(updated, readyEntry("2026-07-10", "live"))).toThrow(
      HistoryStorageUnavailableError
    );
  });

  it("reads all KV list pages and removes duplicate keys", async () => {
    const list = vi.fn(async (options: { prefix?: string; cursor?: string }) => {
      if (!options.cursor) {
        return {
          keys: [{ name: "history-snapshot:2026-07-08" }],
          list_complete: false,
          cursor: "page-2"
        };
      }

      return {
        keys: [
          { name: "history-snapshot:2026-07-09" },
          { name: "history-snapshot:2026-07-08" }
        ],
        list_complete: true
      };
    });
    const env = envWithKv(new Map(), { list });

    await expect(listKeysByPrefix(env, HISTORY_SNAPSHOT_PREFIX)).resolves.toEqual([
      "history-snapshot:2026-07-08",
      "history-snapshot:2026-07-09"
    ]);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: HISTORY_SNAPSHOT_PREFIX });
    expect(list).toHaveBeenNthCalledWith(2, { prefix: HISTORY_SNAPSHOT_PREFIX, cursor: "page-2" });
  });

  it("loads an explicit separate trading calendar when the index omits one", async () => {
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, {
        version: 1,
        entries: [readyEntry("2026-07-08", "backfill")]
      }],
      [MARKET_TRADING_CALENDAR_KEY, {
        version: 1,
        tradingDates: ["2026-07-08", "2026-07-09", "2026-07-10"]
      }]
    ]);

    await expect(getHistoryIndex(envWithKv(values))).resolves.toEqual({
      version: 1,
      tradingDates: ["2026-07-08", "2026-07-09", "2026-07-10"],
      entries: [readyEntry("2026-07-08", "backfill")]
    });
  });

  it("merges the validated repository snapshot when production KV publication is delayed", async () => {
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex(
        ["2026-07-08", "2026-07-09"],
        [readyEntry("2026-07-09", "live"), readyEntry("2026-07-08", "backfill")]
      )]
    ]);

    const index = await getHistoryIndex({
      ...envWithKv(values),
      BUNDLED_HISTORY_FALLBACK: "true"
    });

    expect(index.entries[0]).toMatchObject({
      date: "2026-07-10",
      source: "live",
      status: "ready",
      storage: "bundled"
    });
    expect(index.tradingDates).toContain("2026-07-10");
  });

  it("never infers the exchange calendar from discoverable snapshot keys", async () => {
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, {
        version: 1,
        entries: [readyEntry("2026-07-08", "live")]
      }]
    ]);
    const list = vi.fn(async () => ({
      keys: [{ name: "history-snapshot:2026-07-08" }],
      list_complete: true
    }));
    const env = envWithKv(values, { list });

    await expect(getHistoryIndex(env)).rejects.toBeInstanceOf(HistoryStorageUnavailableError);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects version pointers outside their date-scoped immutable key prefix", async () => {
    const unsafeEntry: HistoryIndexEntry = {
      ...readyEntry("2026-07-08", "live"),
      revision: "0123456789abcdef",
      snapshotKey: "history-snapshot:2026-07-09:v:0123456789abcdef",
      closeKey: "market-close:2026-07-08:v:0123456789abcdef"
    };
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex(["2026-07-08", "2026-07-09"], [unsafeEntry])]
    ]);

    await expect(getHistoryIndex(envWithKv(values))).rejects.toBeInstanceOf(HistoryStorageUnavailableError);
  });
});

describe("historical forward returns", () => {
  it("uses the exchange calendar across a weekend and calculates cumulative returns", async () => {
    const row = makeRow({ triggerDate: "2026-07-10", triggerClose: 10 });
    const values = historyValues({
      entryDate: "2026-07-10",
      tradingDates: ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14"],
      row,
      closeTables: {
        "2026-07-13": { "000001": 11 },
        "2026-07-14": { "000001": 9 }
      }
    });

    const detail = await getHistoryDetail(envWithKv(values), "2026-07-10", {
      now: new Date("2026-07-15T08:00:00.000Z")
    });
    const result = detail.snapshot.boards[0].rows[0].forwardReturns;

    expect(result.t1).toEqual({
      status: "complete",
      tradingDate: "2026-07-13",
      close: 11,
      returnPct: 10
    });
    expect(result.t2).toEqual({
      status: "complete",
      tradingDate: "2026-07-14",
      close: 9,
      returnPct: -10
    });
  });

  it("uses an origin close rebased on the target table's qfq basis", async () => {
    const values = historyValues({
      entryDate: "2026-07-08",
      tradingDates: ["2026-07-08", "2026-07-09"],
      row: makeRow({ triggerDate: "2026-07-08", triggerClose: 10 })
    });
    values.set(`${MARKET_CLOSE_PREFIX}2026-07-09`, {
      marketDate: "2026-07-09",
      closes: { "000001": 9.8 },
      baselineCloses: { "2026-07-08": { "000001": 9.5 } },
      adjustmentBasis: { mode: "qfq", asOf: "2026-07-09" }
    });

    const detail = await getHistoryDetail(envWithKv(values), "2026-07-08", {
      now: new Date("2026-07-10T08:00:00.000Z")
    });

    expect(detail.snapshot.boards[0].rows[0].forwardReturns.t1).toEqual({
      status: "complete",
      tradingDate: "2026-07-09",
      close: 9.8,
      returnPct: 3.16
    });
  });

  it("follows index-last immutable snapshot and target-date close pointers", async () => {
    const revision = "0123456789abcdef";
    const entryDate = "2026-07-08";
    const t1Date = "2026-07-09";
    const t2Date = "2026-07-10";
    const snapshotKey = `${HISTORY_SNAPSHOT_PREFIX}${entryDate}:v:${revision}`;
    const t1CloseKey = `${MARKET_CLOSE_PREFIX}${t1Date}:v:${revision}`;
    const t2CloseKey = `${MARKET_CLOSE_PREFIX}${t2Date}:v:${revision}`;
    const entries: HistoryIndexEntry[] = [
      {
        ...readyEntry(entryDate, "live"),
        revision,
        snapshotKey: snapshotKey,
        closeKey: `${MARKET_CLOSE_PREFIX}${entryDate}:v:${revision}`
      },
      {
        ...readyEntry(t1Date, "live"),
        revision,
        snapshotKey: `${HISTORY_SNAPSHOT_PREFIX}${t1Date}:v:${revision}`,
        closeKey: t1CloseKey
      },
      {
        ...readyEntry(t2Date, "live"),
        revision,
        snapshotKey: `${HISTORY_SNAPSHOT_PREFIX}${t2Date}:v:${revision}`,
        closeKey: t2CloseKey
      }
    ];
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex([entryDate, t1Date, t2Date], entries)],
      [snapshotKey, makeSnapshot(entryDate, [makeRow({ triggerDate: entryDate, triggerClose: 10 })])],
      [t1CloseKey, closeTable(t1Date, { "000001": 11 })],
      [t2CloseKey, closeTable(t2Date, { "000001": 12 })]
    ]);
    const { env, get } = envWithTrackedKv(values);

    const detail = await getHistoryDetail(env, entryDate, {
      now: new Date("2026-07-11T08:00:00.000Z")
    });

    expect(detail.snapshot.boards[0].rows[0].forwardReturns.t2).toMatchObject({
      status: "complete",
      returnPct: 20
    });
    expect(get).toHaveBeenCalledWith(snapshotKey, "json");
    expect(get).toHaveBeenCalledWith(t1CloseKey, "json");
    expect(get).toHaveBeenCalledWith(t2CloseKey, "json");
    expect(get).not.toHaveBeenCalledWith(`${HISTORY_SNAPSHOT_PREFIX}${entryDate}`, "json");
  });

  it("marks the current pre-close and future trading days as pending without reading price tables", async () => {
    const values = historyValues({
      entryDate: "2026-07-13",
      tradingDates: ["2026-07-13", "2026-07-14", "2026-07-15"],
      row: makeRow({ triggerDate: "2026-07-13", triggerClose: 10 })
    });
    const { env, get } = envWithTrackedKv(values);
    const detail = await getHistoryDetail(env, "2026-07-13", {
      now: new Date("2026-07-14T06:00:00.000Z")
    });
    const result = detail.snapshot.boards[0].rows[0].forwardReturns;

    expect(result.t1).toMatchObject({
      status: "pending",
      tradingDate: "2026-07-14",
      reason: "not-reached"
    });
    expect(result.t2).toMatchObject({
      status: "pending",
      tradingDate: "2026-07-15",
      reason: "not-reached"
    });
    expect(get.mock.calls.flat().some((value) => String(value).startsWith(MARKET_CLOSE_PREFIX))).toBe(false);
  });

  it("uses missing rather than skipping a due trading day or a suspended stock", async () => {
    const values = historyValues({
      entryDate: "2026-07-08",
      tradingDates: ["2026-07-08", "2026-07-09", "2026-07-10"],
      row: makeRow({ triggerDate: "2026-07-08", triggerClose: 10 }),
      closeTables: {
        "2026-07-10": { "000002": 12 }
      }
    });
    const detail = await getHistoryDetail(envWithKv(values), "2026-07-08", {
      now: new Date("2026-07-11T08:00:00.000Z")
    });
    const result = detail.snapshot.boards[0].rows[0].forwardReturns;

    expect(result.t1).toMatchObject({
      status: "missing",
      tradingDate: "2026-07-09",
      reason: "market-close-table"
    });
    expect(result.t2).toMatchObject({
      status: "missing",
      tradingDate: "2026-07-10",
      reason: "stock-close"
    });
  });

  it("marks stale trigger dates and missing trigger closes as missing", async () => {
    const staleRow = makeRow({ code: "000001", triggerDate: "2026-07-07", triggerClose: 10 });
    const noTriggerClose = makeRow({ code: "000002", triggerDate: "2026-07-08", triggerClose: undefined });
    const snapshot = makeSnapshot("2026-07-08", [staleRow, noTriggerClose]);
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex(
        ["2026-07-08", "2026-07-09", "2026-07-10"],
        [readyEntry("2026-07-08", "backfill")]
      )],
      [`${HISTORY_SNAPSHOT_PREFIX}2026-07-08`, snapshot],
      [`${MARKET_CLOSE_PREFIX}2026-07-09`, closeTable("2026-07-09", { "000001": 11, "000002": 11 })],
      [`${MARKET_CLOSE_PREFIX}2026-07-10`, closeTable("2026-07-10", { "000001": 12, "000002": 12 })]
    ]);
    const detail = await getHistoryDetail(envWithKv(values), "2026-07-08", {
      now: new Date("2026-07-11T08:00:00.000Z")
    });

    expect(detail.snapshot.boards[0].rows[0].forwardReturns.t1).toMatchObject({
      status: "missing",
      reason: "trigger-date"
    });
    expect(detail.snapshot.boards[0].rows[1].forwardReturns.t1).toMatchObject({
      status: "missing",
      reason: "trigger-close"
    });
  });

  it("keeps an unpublished next calendar slot pending rather than using a later snapshot", async () => {
    const values = historyValues({
      entryDate: "2026-07-10",
      tradingDates: ["2026-07-10"],
      row: makeRow({ triggerDate: "2026-07-10", triggerClose: 10 })
    });
    const detail = await getHistoryDetail(envWithKv(values), "2026-07-10", {
      now: new Date("2026-07-20T08:00:00.000Z")
    });

    expect(detail.snapshot.boards[0].rows[0].forwardReturns).toEqual({
      t1: {
        status: "pending",
        tradingDate: null,
        close: null,
        returnPct: null,
        reason: "calendar-not-published"
      },
      t2: {
        status: "pending",
        tradingDate: null,
        close: null,
        returnPct: null,
        reason: "calendar-not-published"
      }
    });
  });

  it("uses China market time for the 15:00 close boundary", () => {
    expect(isMarketCloseReached("2026-07-10", new Date("2026-07-10T06:59:59.000Z"))).toBe(false);
    expect(isMarketCloseReached("2026-07-10", new Date("2026-07-10T07:00:00.000Z"))).toBe(true);
  });
});

describe("strict history failures", () => {
  it("rejects an invalid date before touching KV", async () => {
    const { env, get } = envWithTrackedKv(new Map());

    await expect(getHistoryDetail(env, "2026-02-30")).rejects.toBeInstanceOf(InvalidHistoryDateError);
    expect(get).not.toHaveBeenCalled();
  });

  it("distinguishes an unavailable date from an indexed payload integrity failure", async () => {
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex(
        ["2026-07-08", "2026-07-09"],
        [readyEntry("2026-07-08", "backfill")]
      )]
    ]);
    const env = envWithKv(values);

    await expect(getHistoryDetail(env, "2026-07-09")).rejects.toBeInstanceOf(HistoryNotFoundError);
    await expect(getHistoryDetail(env, "2026-07-08")).rejects.toBeInstanceOf(HistoryStorageUnavailableError);
  });

  it("reports missing bindings, KV exceptions, and malformed payloads as storage unavailable", async () => {
    await expect(getHistoryIndex({})).rejects.toBeInstanceOf(HistoryStorageUnavailableError);

    const throwingGet = vi.fn(async () => {
      throw new Error("temporary KV outage");
    });
    await expect(getHistoryIndex(envWithKv(new Map(), { get: throwingGet }))).rejects.toBeInstanceOf(
      HistoryStorageUnavailableError
    );

    const malformed = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, { version: 1, tradingDates: ["2026-07-08"], entries: "not-an-array" }]
    ]);
    await expect(getHistoryIndex(envWithKv(malformed))).rejects.toBeInstanceOf(HistoryStorageUnavailableError);
  });

  it("rejects malformed rows in an indexed snapshot as a storage integrity failure", async () => {
    const row = makeRow();
    const malformedRow = { ...row } as Record<string, unknown>;
    delete malformedRow.signalStrength;
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, makeIndex(
        ["2026-07-08", "2026-07-09", "2026-07-10"],
        [readyEntry("2026-07-08", "backfill")]
      )],
      [`${HISTORY_SNAPSHOT_PREFIX}2026-07-08`, makeSnapshot("2026-07-08", [malformedRow as unknown as SignalRow])]
    ]);

    await expect(getHistoryDetail(envWithKv(values), "2026-07-08", {
      now: new Date("2026-07-08T08:00:00.000Z")
    })).rejects.toBeInstanceOf(HistoryStorageUnavailableError);
  });
});

function readyEntry(date: string, source: HistoryIndexEntry["source"]): HistoryIndexEntry {
  return { date, source, status: "ready" };
}

function makeIndex(tradingDates: string[], entries: HistoryIndexEntry[]): SignalHistoryIndex {
  return {
    version: 1,
    tradingDates,
    entries
  };
}

function makeRow(overrides: Record<string, unknown> = {}): SignalRow {
  return {
    code: "000001",
    name: "测试股票",
    signalId: "low-rebound",
    signalName: "测试信号",
    stance: "观察",
    triggerDate: "2026-07-08",
    triggerClose: 10,
    turnoverRate: 2,
    floatMarketCap: 10_000_000_000,
    liquidityEligible: true,
    liquidityTags: [],
    indicators: {
      kdj: { k: 20, d: 18, j: 24 },
      macd: { dif: 0.1, dea: 0.05, histogram: 0.05 },
      rsi: 35
    },
    amount: 300_000_000,
    industry: "测试行业",
    change5d: 1,
    change20d: 2,
    riskTags: ["信号待确认"],
    signalStrength: 80,
    ...overrides
  } as SignalRow;
}

function makeSnapshot(date: string, rows: SignalRow[]): SignalSnapshot {
  const boardIds = ["low-rebound", "trend-strength", "oversold-repair", "risk-filter"] as const;
  return {
    marketDate: date,
    refreshedAt: `${date}T15:30:00+08:00`,
    source: "provider",
    sourceLabel: "测试数据源",
    meta: {
      scanLimit: rows.length,
      stockCount: rows.length,
      universeSource: "provider",
      historySource: "provider",
      failureCount: 0,
      buildMode: "local"
    },
    boards: boardIds.map((id) => ({
      id,
      title: id,
      signalName: "测试信号",
      stance: id === "risk-filter" ? "谨慎" : "观察",
      summary: "测试",
      rows: id === "low-rebound" ? rows : []
    })),
    topRows: rows,
    philosophy: "测试",
    disclaimers: ["测试"]
  };
}

function closeTable(date: string, closes: Record<string, number>): unknown {
  return {
    marketDate: date,
    closes
  };
}

function historyValues(options: {
  entryDate: string;
  tradingDates: string[];
  row: SignalRow;
  closeTables?: Record<string, Record<string, number>>;
}): Map<string, unknown> {
  const values = new Map<string, unknown>([
    [HISTORY_INDEX_KEY, makeIndex(options.tradingDates, [readyEntry(options.entryDate, "backfill")])],
    [`${HISTORY_SNAPSHOT_PREFIX}${options.entryDate}`, makeSnapshot(options.entryDate, [options.row])]
  ]);

  for (const [date, closes] of Object.entries(options.closeTables ?? {})) {
    values.set(`${MARKET_CLOSE_PREFIX}${date}`, closeTable(date, closes));
  }

  return values;
}

function envWithKv(
  values: Map<string, unknown>,
  overrides: {
    get?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {}
): Env {
  const get = overrides.get ?? vi.fn(async (key: string) => values.get(key) ?? null);
  const list = overrides.list ?? vi.fn(async () => ({ keys: [], list_complete: true }));
  return {
    SIGNAL_KV: { get, list } as unknown as KVNamespace
  };
}

function envWithTrackedKv(values: Map<string, unknown>): {
  env: Env;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  return {
    env: envWithKv(values, { get }),
    get
  };
}
