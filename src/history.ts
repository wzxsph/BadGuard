import type { Env } from "./data-source";
import type { SignalBoard, SignalRow, SignalSnapshot } from "./types";

export const HISTORY_INDEX_KEY = "signal-history-index";
export const HISTORY_SNAPSHOT_PREFIX = "history-snapshot:";
export const MARKET_CLOSE_PREFIX = "market-close:";
export const MARKET_TRADING_CALENDAR_KEY = "market-trading-calendar";
export const HISTORY_INDEX_VERSION = 1 as const;

export type HistorySource = "live" | "backfill";

export interface HistoryIndexEntry {
  date: string;
  source: HistorySource;
  status: "ready";
  /** Temporary repository recovery record; replaced by a complete shard bundle. */
  bootstrapSeed?: boolean;
  publishedAt?: string;
  /** Optional immutable payload pointer used for atomic force-publish. */
  snapshotKey?: string;
  /** Optional immutable close-table pointer for this entry's trading date. */
  closeKey?: string;
  /** Opaque, key-safe publication revision for observability. */
  revision?: string;
}

/**
 * `tradingDates` is the exchange calendar, not a list derived from snapshots.
 * It must include missing-publication trading days so T+1/T+2 never skip them.
 */
export interface SignalHistoryIndex {
  version: typeof HISTORY_INDEX_VERSION;
  tradingDates: string[];
  entries: HistoryIndexEntry[];
  updatedAt?: string;
}

export interface MarketTradingCalendar {
  version: typeof HISTORY_INDEX_VERSION;
  tradingDates: string[];
  updatedAt?: string;
}

export interface MarketCloseTable {
  marketDate: string;
  closes: Record<string, number>;
  /** Origin-date closes rebased with the same adjusted series as `closes`. */
  baselineCloses?: Record<string, Record<string, number>>;
  adjustmentBasis?: {
    mode: "qfq" | "hfq" | "none";
    asOf: string;
  };
  updatedAt?: string;
}

export interface CompleteForwardReturn {
  status: "complete";
  tradingDate: string;
  close: number;
  returnPct: number;
}

export interface PendingForwardReturn {
  status: "pending";
  tradingDate: string | null;
  close: null;
  returnPct: null;
  reason: "calendar-not-published" | "not-reached";
}

export interface MissingForwardReturn {
  status: "missing";
  tradingDate: string;
  close: null;
  returnPct: null;
  reason: "trigger-date" | "trigger-close" | "baseline-close" | "market-close-table" | "stock-close";
}

export type ForwardReturnResult = CompleteForwardReturn | PendingForwardReturn | MissingForwardReturn;

export interface HistorySignalRow extends SignalRow {
  forwardReturns: {
    t1: ForwardReturnResult;
    t2: ForwardReturnResult;
  };
}

export type HistorySignalBoard = Omit<SignalBoard, "rows"> & {
  rows: HistorySignalRow[];
};

export type EnrichedHistorySnapshot = Omit<SignalSnapshot, "boards" | "topRows"> & {
  boards: HistorySignalBoard[];
  topRows: HistorySignalRow[];
};

export interface HistoryDetail {
  date: string;
  source: HistorySource;
  entry: HistoryIndexEntry;
  snapshot: EnrichedHistorySnapshot;
}

export interface HistoryDetailOptions {
  now?: Date;
}

export class InvalidHistoryDateError extends Error {
  readonly code = "invalid_history_date";
  readonly status = 400;

  constructor(readonly date: string) {
    super(`Invalid history date: ${date}`);
    this.name = "InvalidHistoryDateError";
  }
}

export class HistoryNotFoundError extends Error {
  readonly code = "history_not_found";
  readonly status = 404;

  constructor(readonly date: string) {
    super(`History snapshot not found: ${date}`);
    this.name = "HistoryNotFoundError";
  }
}

export class HistoryStorageUnavailableError extends Error {
  readonly code = "history_storage_unavailable";
  readonly status = 503;

  constructor(message = "History storage is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryStorageUnavailableError";
  }
}

export function isValidHistoryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertValidHistoryDate(value: string): asserts value is string {
  if (!isValidHistoryDate(value)) {
    throw new InvalidHistoryDateError(value);
  }
}

/**
 * Normalizes persisted ordering and removes duplicates. When duplicate entries
 * exist, the last occurrence wins so an appended force-publish record replaces
 * the older one.
 */
export function normalizeHistoryIndex(index: SignalHistoryIndex): SignalHistoryIndex {
  if (index.version !== HISTORY_INDEX_VERSION) {
    throw contractError(`Unsupported history index version: ${String(index.version)}`);
  }

  const tradingDates = normalizeTradingDates(index.tradingDates, "history index");
  const byDate = new Map<string, HistoryIndexEntry>();

  for (const entry of index.entries) {
    validateHistoryEntry(entry);
    byDate.set(entry.date, { ...entry });
  }

  const entries = Array.from(byDate.values()).sort((left, right) => right.date.localeCompare(left.date));
  if (tradingDates.length > 0) {
    const tradingDateSet = new Set(tradingDates);
    const orphan = entries.find((entry) => !tradingDateSet.has(entry.date));
    if (orphan) {
      throw contractError(`Ready history entry ${orphan.date} is absent from the exchange calendar`);
    }
  }

  return {
    version: HISTORY_INDEX_VERSION,
    tradingDates,
    entries,
    ...(index.updatedAt ? { updatedAt: index.updatedAt } : {})
  };
}

/**
 * Replaces all existing records for one date without inventing a trading day.
 * Callers must update the explicit calendar before publishing a new entry.
 */
export function upsertHistoryIndex(index: SignalHistoryIndex, entry: HistoryIndexEntry): SignalHistoryIndex {
  const normalized = normalizeHistoryIndex(index);
  validateHistoryEntry(entry);

  if (!normalized.tradingDates.includes(entry.date)) {
    throw contractError(`Cannot publish ${entry.date} before it exists in the exchange calendar`);
  }

  return normalizeHistoryIndex({
    ...normalized,
    entries: [
      ...normalized.entries.filter((existing) => existing.date !== entry.date),
      { ...entry }
    ]
  });
}

/**
 * Reads every KV list page for diagnostics and backfill tooling. This helper is
 * deliberately not used as a trading-calendar source.
 */
export async function listKeysByPrefix(env: Env, prefix: string): Promise<string[]> {
  const kv = requireHistoryKv(env);
  const names = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    let page: KVNamespaceListResult<unknown>;
    try {
      page = await kv.list<unknown>({ prefix, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      throw storageError(`Unable to list history keys with prefix ${prefix}`, error);
    }

    if (!page || !Array.isArray(page.keys)) {
      throw contractError(`Malformed KV list response for prefix ${prefix}`);
    }

    for (const key of page.keys) {
      if (!key || typeof key.name !== "string") {
        throw contractError(`Malformed KV key returned for prefix ${prefix}`);
      }
      names.add(key.name);
    }

    if (page.list_complete) {
      break;
    }

    const nextCursor = page.cursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw contractError(`KV pagination did not advance for prefix ${prefix}`);
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

export async function getHistoryIndex(env: Env): Promise<SignalHistoryIndex> {
  const kv = requireHistoryKv(env);
  const rawIndex = await strictGetJson(kv, HISTORY_INDEX_KEY);
  let index = rawIndex === null ? emptyHistoryIndex() : parseHistoryIndex(rawIndex);

  if (index.tradingDates.length === 0) {
    const rawCalendar = await strictGetJson(kv, MARKET_TRADING_CALENDAR_KEY);
    if (rawCalendar !== null) {
      index = {
        ...index,
        tradingDates: parseTradingCalendar(rawCalendar).tradingDates
      };
    }
  }

  index = normalizeHistoryIndex(index);
  if (index.entries.length > 0 && index.tradingDates.length === 0) {
    throw contractError("History entries exist without an explicit exchange calendar");
  }

  return index;
}

export async function getHistoryDetail(
  env: Env,
  date: string,
  options: HistoryDetailOptions = {}
): Promise<HistoryDetail> {
  assertValidHistoryDate(date);

  const index = await getHistoryIndex(env);
  const entry = index.entries.find((candidate) => candidate.date === date);
  if (!entry) {
    throw new HistoryNotFoundError(date);
  }

  const calendarIndex = index.tradingDates.indexOf(date);
  if (calendarIndex < 0) {
    throw contractError(`Ready history entry ${date} is absent from the exchange calendar`);
  }

  const t1Date = index.tradingDates[calendarIndex + 1] ?? null;
  const t2Date = index.tradingDates[calendarIndex + 2] ?? null;
  const now = options.now ?? new Date();
  const kv = requireHistoryKv(env);
  const snapshot = await readHistorySnapshot(
    kv,
    date,
    entry.snapshotKey ?? `${HISTORY_SNAPSHOT_PREFIX}${date}`
  );
  const entriesByDate = new Map(index.entries.map((candidate) => [candidate.date, candidate]));
  const dueDates = Array.from(new Set(
    [t1Date, t2Date].filter((target): target is string => Boolean(target) && isMarketCloseReached(target, now))
  ));
  const closeTables = new Map<string, MarketCloseTable | null>();

  await Promise.all(dueDates.map(async (targetDate) => {
    const targetEntry = entriesByDate.get(targetDate);
    const closeKey = targetEntry?.closeKey ?? `${MARKET_CLOSE_PREFIX}${targetDate}`;
    closeTables.set(targetDate, await readMarketCloseTable(kv, targetDate, closeKey));
  }));

  const enrichRow = (row: SignalRow): HistorySignalRow => ({
    ...row,
    forwardReturns: {
      t1: buildForwardReturn(row, date, t1Date, now, closeTables),
      t2: buildForwardReturn(row, date, t2Date, now, closeTables)
    }
  });

  return {
    date,
    source: entry.source,
    entry,
    snapshot: {
      ...snapshot,
      boards: snapshot.boards.map((board) => ({
        ...board,
        rows: board.rows.map(enrichRow)
      })),
      topRows: snapshot.topRows.map(enrichRow)
    }
  };
}

export function isMarketCloseReached(tradingDate: string, now = new Date()): boolean {
  assertValidHistoryDate(tradingDate);
  const chinaNow = getChinaDateTime(now);

  if (tradingDate < chinaNow.date) {
    return true;
  }

  if (tradingDate > chinaNow.date) {
    return false;
  }

  return chinaNow.hour * 60 + chinaNow.minute >= 15 * 60;
}

function buildForwardReturn(
  row: SignalRow,
  entryDate: string,
  targetDate: string | null,
  now: Date,
  closeTables: ReadonlyMap<string, MarketCloseTable | null>
): ForwardReturnResult {
  if (!targetDate) {
    return {
      status: "pending",
      tradingDate: null,
      close: null,
      returnPct: null,
      reason: "calendar-not-published"
    };
  }

  if (!isMarketCloseReached(targetDate, now)) {
    return {
      status: "pending",
      tradingDate: targetDate,
      close: null,
      returnPct: null,
      reason: "not-reached"
    };
  }

  if (row.triggerDate !== entryDate) {
    return missingForwardReturn(targetDate, "trigger-date");
  }

  const closeTable = closeTables.get(targetDate) ?? null;
  if (!closeTable) {
    return missingForwardReturn(targetDate, "market-close-table");
  }

  const triggerClose = closeTable.adjustmentBasis
    ? closeTable.baselineCloses?.[entryDate]?.[row.code] ?? null
    : getTriggerClose(row);
  if (!isPositiveNumber(triggerClose)) {
    return missingForwardReturn(
      targetDate,
      closeTable.adjustmentBasis ? "baseline-close" : "trigger-close"
    );
  }

  const close = closeTable.closes[row.code];
  if (!isPositiveNumber(close)) {
    return missingForwardReturn(targetDate, "stock-close");
  }

  const rawReturn = ((close / triggerClose) - 1) * 100;
  const roundedReturn = Math.round(rawReturn * 100) / 100;
  return {
    status: "complete",
    tradingDate: targetDate,
    close,
    returnPct: Object.is(roundedReturn, -0) ? 0 : roundedReturn
  };
}

function missingForwardReturn(
  tradingDate: string,
  reason: MissingForwardReturn["reason"]
): MissingForwardReturn {
  return {
    status: "missing",
    tradingDate,
    close: null,
    returnPct: null,
    reason
  };
}

function getTriggerClose(row: SignalRow): number | null {
  const value = (row as SignalRow & { triggerClose?: unknown }).triggerClose;
  return isPositiveNumber(value) ? value : null;
}

async function readHistorySnapshot(kv: KVNamespace, date: string, key: string): Promise<SignalSnapshot> {
  const raw = await strictGetJson(kv, key);
  if (raw === null) {
    throw contractError(`Indexed history snapshot payload is missing for ${date}`);
  }

  if (
    !isRecord(raw) ||
    raw.marketDate !== date ||
    typeof raw.refreshedAt !== "string" ||
    raw.source !== "provider" ||
    typeof raw.sourceLabel !== "string" ||
    !Array.isArray(raw.boards) ||
    raw.boards.length !== 4 ||
    !Array.isArray(raw.topRows)
  ) {
    throw contractError(`Malformed history snapshot for ${date}`);
  }

  const boardIds = new Set<string>();
  for (const board of raw.boards) {
    if (
      !isRecord(board) ||
      !isSignalId(board.id) ||
      boardIds.has(board.id) ||
      typeof board.title !== "string" ||
      typeof board.signalName !== "string" ||
      (board.stance !== "观察" && board.stance !== "谨慎") ||
      typeof board.summary !== "string" ||
      !Array.isArray(board.rows) ||
      !board.rows.every((row) => isSignalRowShape(row) && row.signalId === board.id)
    ) {
      throw contractError(`Malformed history board for ${date}`);
    }
    boardIds.add(board.id);
  }

  if (!raw.topRows.every((row) => isSignalRowShape(row) && row.signalId !== "risk-filter")) {
    throw contractError(`Malformed history top rows for ${date}`);
  }

  return raw as unknown as SignalSnapshot;
}

async function readMarketCloseTable(
  kv: KVNamespace,
  date: string,
  key: string
): Promise<MarketCloseTable | null> {
  const raw = await strictGetJson(kv, key);
  if (raw === null) {
    return null;
  }

  if (!isRecord(raw) || raw.marketDate !== date || !isRecord(raw.closes)) {
    throw contractError(`Malformed market close table for ${date}`);
  }

  const closes: Record<string, number> = {};
  for (const [code, close] of Object.entries(raw.closes)) {
    if (typeof close !== "number" || !Number.isFinite(close)) {
      throw contractError(`Malformed close for ${code} on ${date}`);
    }
    closes[code] = close;
  }

  const hasBaselines = raw.baselineCloses !== undefined;
  const hasBasis = raw.adjustmentBasis !== undefined;
  if (hasBaselines !== hasBasis) {
    throw contractError(`Incomplete adjustment basis in close table for ${date}`);
  }

  let baselineCloses: Record<string, Record<string, number>> | undefined;
  let adjustmentBasis: MarketCloseTable["adjustmentBasis"];
  if (hasBaselines && hasBasis) {
    if (!isRecord(raw.baselineCloses) || !isRecord(raw.adjustmentBasis)) {
      throw contractError(`Malformed adjustment basis in close table for ${date}`);
    }
    const mode = raw.adjustmentBasis.mode;
    const asOf = raw.adjustmentBasis.asOf;
    if (
      (mode !== "qfq" && mode !== "hfq" && mode !== "none") ||
      typeof asOf !== "string" ||
      !isValidHistoryDate(asOf) ||
      asOf < date
    ) {
      throw contractError(`Malformed adjustment basis metadata for ${date}`);
    }

    baselineCloses = {};
    for (const [originDate, values] of Object.entries(raw.baselineCloses)) {
      if (!isValidHistoryDate(originDate) || originDate >= date || !isRecord(values)) {
        throw contractError(`Malformed baseline date for ${date}`);
      }
      const codeCloses: Record<string, number> = {};
      for (const [code, close] of Object.entries(values)) {
        if (!/^\d{6}$/.test(code) || !isPositiveNumber(close)) {
          throw contractError(`Malformed baseline close for ${code} on ${originDate}`);
        }
        codeCloses[code] = close;
      }
      baselineCloses[originDate] = codeCloses;
    }
    adjustmentBasis = { mode, asOf };
  }

  return {
    marketDate: date,
    closes,
    ...(baselineCloses ? { baselineCloses } : {}),
    ...(adjustmentBasis ? { adjustmentBasis } : {}),
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {})
  };
}

function parseHistoryIndex(raw: unknown): SignalHistoryIndex {
  if (!isRecord(raw) || raw.version !== HISTORY_INDEX_VERSION || !Array.isArray(raw.entries)) {
    throw contractError("Malformed history index");
  }

  const tradingDates = raw.tradingDates === undefined ? [] : raw.tradingDates;
  if (!Array.isArray(tradingDates)) {
    throw contractError("Malformed history index trading dates");
  }

  const entries = raw.entries.map((entry) => parseHistoryEntry(entry));
  return normalizeHistoryIndex({
    version: HISTORY_INDEX_VERSION,
    tradingDates: tradingDates as string[],
    entries,
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {})
  });
}

function parseHistoryEntry(raw: unknown): HistoryIndexEntry {
  if (
    !isRecord(raw) ||
    typeof raw.date !== "string" ||
    (raw.source !== "live" && raw.source !== "backfill") ||
    raw.status !== "ready" ||
    (raw.bootstrapSeed !== undefined && typeof raw.bootstrapSeed !== "boolean") ||
    (raw.publishedAt !== undefined && typeof raw.publishedAt !== "string") ||
    (raw.snapshotKey !== undefined && typeof raw.snapshotKey !== "string") ||
    (raw.closeKey !== undefined && typeof raw.closeKey !== "string") ||
    (raw.revision !== undefined && typeof raw.revision !== "string")
  ) {
    throw contractError("Malformed history index entry");
  }

  const entry: HistoryIndexEntry = {
    date: raw.date,
    source: raw.source,
    status: "ready"
  };
  if (raw.bootstrapSeed === true) {
    entry.bootstrapSeed = true;
  }
  if (typeof raw.publishedAt === "string") {
    entry.publishedAt = raw.publishedAt;
  }
  if (typeof raw.snapshotKey === "string") {
    entry.snapshotKey = raw.snapshotKey;
  }
  if (typeof raw.closeKey === "string") {
    entry.closeKey = raw.closeKey;
  }
  if (typeof raw.revision === "string") {
    entry.revision = raw.revision;
  }

  validateHistoryEntry(entry);
  return entry;
}

function parseTradingCalendar(raw: unknown): MarketTradingCalendar {
  const rawDates = Array.isArray(raw)
    ? raw
    : isRecord(raw) && raw.version === HISTORY_INDEX_VERSION && Array.isArray(raw.tradingDates)
      ? raw.tradingDates
      : null;

  if (!rawDates) {
    throw contractError("Malformed market trading calendar");
  }

  return {
    version: HISTORY_INDEX_VERSION,
    tradingDates: normalizeTradingDates(rawDates as string[], "market trading calendar"),
    ...(isRecord(raw) && typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {})
  };
}

function normalizeTradingDates(values: string[], label: string): string[] {
  const dates = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !isValidHistoryDate(value)) {
      throw contractError(`Invalid date in ${label}: ${String(value)}`);
    }
    dates.add(value);
  }

  return Array.from(dates).sort((left, right) => left.localeCompare(right));
}

function validateHistoryEntry(entry: HistoryIndexEntry): void {
  if (
    !isValidHistoryDate(entry.date) ||
    (entry.source !== "live" && entry.source !== "backfill") ||
    entry.status !== "ready" ||
    (entry.bootstrapSeed !== undefined && typeof entry.bootstrapSeed !== "boolean") ||
    (entry.publishedAt !== undefined && typeof entry.publishedAt !== "string") ||
    (entry.snapshotKey !== undefined && !isSafePayloadKey(entry.snapshotKey, HISTORY_SNAPSHOT_PREFIX, entry.date)) ||
    (entry.closeKey !== undefined && !isSafePayloadKey(entry.closeKey, MARKET_CLOSE_PREFIX, entry.date)) ||
    (entry.revision !== undefined && !isSafeRevision(entry.revision))
  ) {
    throw contractError(`Invalid history index entry for ${String(entry.date)}`);
  }
}

function emptyHistoryIndex(): SignalHistoryIndex {
  return {
    version: HISTORY_INDEX_VERSION,
    tradingDates: [],
    entries: []
  };
}

function isSignalRowShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.code === "string" &&
    typeof value.name === "string" &&
    isSignalId(value.signalId) &&
    typeof value.signalName === "string" &&
    (value.stance === "观察" || value.stance === "谨慎") &&
    typeof value.triggerDate === "string" &&
    isValidHistoryDate(value.triggerDate) &&
    (value.triggerClose === undefined || value.triggerClose === null || isPositiveNumber(value.triggerClose)) &&
    isIndicatorShape(value.indicators) &&
    isNonNegativeNumber(value.amount) &&
    isOptionalNonNegativeNumber(value.turnoverRate) &&
    isOptionalNonNegativeNumber(value.floatMarketCap) &&
    typeof value.liquidityEligible === "boolean" &&
    isStringArray(value.liquidityTags) &&
    typeof value.industry === "string" &&
    isFiniteNumber(value.change5d) &&
    isFiniteNumber(value.change20d) &&
    isStringArray(value.riskTags) &&
    isFiniteNumber(value.signalStrength) &&
    value.signalStrength >= 0 &&
    value.signalStrength <= 100
  );
}

async function strictGetJson(kv: KVNamespace, key: string): Promise<unknown | null> {
  try {
    return await kv.get<unknown>(key, "json");
  } catch (error) {
    throw storageError(`Unable to read ${key}`, error);
  }
}

function requireHistoryKv(env: Env): KVNamespace {
  if (!env.SIGNAL_KV) {
    throw new HistoryStorageUnavailableError("SIGNAL_KV binding is not configured");
  }
  return env.SIGNAL_KV;
}

function storageError(message: string, cause: unknown): HistoryStorageUnavailableError {
  if (cause instanceof HistoryStorageUnavailableError) {
    return cause;
  }

  return new HistoryStorageUnavailableError(message, { cause });
}

function contractError(message: string): HistoryStorageUnavailableError {
  return new HistoryStorageUnavailableError(message);
}

function getChinaDateTime(date: Date): { date: string; hour: number; minute: number } {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Invalid current date");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === null || isNonNegativeNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIndicatorShape(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.kdj) || !isRecord(value.macd)) {
    return false;
  }

  return (
    isFiniteNumber(value.kdj.k) &&
    isFiniteNumber(value.kdj.d) &&
    isFiniteNumber(value.kdj.j) &&
    isFiniteNumber(value.macd.dif) &&
    isFiniteNumber(value.macd.dea) &&
    isFiniteNumber(value.macd.histogram) &&
    isFiniteNumber(value.rsi)
  );
}

function isSignalId(value: unknown): value is SignalRow["signalId"] {
  return value === "low-rebound" || value === "trend-strength" || value === "oversold-repair" || value === "risk-filter";
}

function isSafePayloadKey(key: string, prefix: string, date: string): boolean {
  const canonicalKey = `${prefix}${date}`;
  if (key === canonicalKey) {
    return true;
  }

  return key.startsWith(`${canonicalKey}:v:`) && isSafeRevision(key.slice(canonicalKey.length + 3));
}

function isSafeRevision(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
