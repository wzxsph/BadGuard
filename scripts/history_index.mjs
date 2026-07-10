export function shouldPublishDate(entries, date, force, { replaceBootstrap = false } = {}) {
  if (force) return true;
  const existing = entries.find((entry) => entry.date === date && entry.status === "ready");
  return !existing || (replaceBootstrap && existing.bootstrapSeed === true);
}

export function needsFullHistoryBootstrap(entries, historyStart = "2026-07-08") {
  const startReady = entries.some((entry) => entry?.date === historyStart && entry?.status === "ready");
  const seedRemains = entries.some((entry) => entry?.bootstrapSeed === true);
  return !startReady || seedRemains;
}

export function mergeHistoryIndex(existingIndex, tradingDates, updates, updatedAt) {
  const byDate = new Map((existingIndex?.entries || []).map((entry) => [entry.date, entry]));
  for (const entry of updates) byDate.set(entry.date, entry);
  return {
    version: 1,
    tradingDates: [...tradingDates],
    entries: [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date)),
    updatedAt
  };
}

export function selectLatestLiveArtifact(artifacts, existingLatestDate) {
  const newestLive = artifacts
    .filter((artifact) => artifact.source === "live")
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  if (!newestLive) return null;
  if (existingLatestDate && newestLive.date < existingLatestDate) return null;
  return newestLive;
}

export function isImmutablePayloadPointer(key, prefix, date) {
  if (typeof key !== "string") return false;
  const canonical = `${prefix}${date}`;
  return key.startsWith(`${canonical}:v:`) && /^[0-9a-f]{16}$/.test(key.slice(canonical.length + 3));
}

export function isFullCodeListProductionSnapshot(snapshot) {
  const meta = snapshot?.meta;
  return Boolean(
    meta &&
    meta.buildMode === "production" &&
    meta.universeSource === "code-list" &&
    meta.scanLimit === 0 &&
    Number.isInteger(meta.stockCount) &&
    meta.stockCount > 0
  );
}

export function assertStableStockCount(previousSnapshot, nextSnapshot, maximumShrink = 0.01) {
  if (!isFullCodeListProductionSnapshot(previousSnapshot) || !isFullCodeListProductionSnapshot(nextSnapshot)) {
    return { checked: false, shrinkRate: null };
  }
  const previousCount = previousSnapshot.meta.stockCount;
  const nextCount = nextSnapshot.meta.stockCount;
  const shrinkRate = (previousCount - nextCount) / previousCount;
  if (shrinkRate > maximumShrink + Number.EPSILON) {
    throw new Error(
      `Full code-list stockCount shrank from ${previousCount} to ${nextCount} (${(shrinkRate * 100).toFixed(2)}%), exceeding ${(maximumShrink * 100).toFixed(0)}%.`
    );
  }
  return { checked: true, shrinkRate };
}

export function assertSnapshotCompleteness(
  snapshot,
  closeTable,
  minimumHistoryCoverage = 0.98,
  minimumCloseCoverage = 0.90
) {
  const meta = snapshot?.meta;
  const stockCount = meta?.stockCount;
  const historySuccessCount = meta?.historySuccessCount;
  const exactCloseCount = meta?.exactCloseCount;
  const closeCount = closeTable?.closes && typeof closeTable.closes === "object" && !Array.isArray(closeTable.closes)
    ? Object.keys(closeTable.closes).length
    : -1;
  const missingCodes = closeTable?.missingCodes;
  const providerMissingCodes = closeTable?.providerMissingCodes;
  const notListedCodes = closeTable?.notListedCodes;
  const suspendedCodes = closeTable?.suspendedCodes;
  if (
    !Number.isInteger(stockCount) || stockCount <= 0 ||
    !Number.isInteger(historySuccessCount) || historySuccessCount < 0 || historySuccessCount > stockCount ||
    !Number.isInteger(meta?.failureCount) || meta.failureCount !== stockCount - historySuccessCount ||
    !Number.isInteger(exactCloseCount) || exactCloseCount !== closeCount
  ) {
    throw new Error("Completeness counts do not match the close table.");
  }
  if (meta.buildMode === "production" && meta.perBoardLimit !== 0) {
    throw new Error("Production snapshots must retain all board rows (perBoardLimit=0).");
  }

  for (const [label, values] of Object.entries({
    missingCodes,
    providerMissingCodes,
    notListedCodes,
    suspendedCodes
  })) {
    if (!Array.isArray(values) || values.some((code) => !/^\d{6}$/.test(String(code))) || new Set(values).size !== values.length) {
      throw new Error(`Close-table ${label} must be a unique six-digit code list.`);
    }
  }
  const classifiedMissing = [...providerMissingCodes, ...notListedCodes, ...suspendedCodes];
  if (
    new Set(classifiedMissing).size !== classifiedMissing.length ||
    JSON.stringify([...missingCodes].sort()) !== JSON.stringify([...classifiedMissing].sort()) ||
    Object.keys(closeTable.closes).some((code) => missingCodes.includes(code)) ||
    closeCount + missingCodes.length !== stockCount ||
    providerMissingCodes.length !== meta.failureCount ||
    providerMissingCodes.length !== meta.providerMissingCount ||
    notListedCodes.length !== meta.notListedCount ||
    suspendedCodes.length !== meta.suspendedCount
  ) {
    throw new Error("Exact-close missing codes are not partitioned into provider-missing, not-listed, and suspended sets.");
  }

  const historyRate = historySuccessCount / stockCount;
  const closeRate = closeCount / stockCount;
  if (
    historyRate + Number.EPSILON < minimumHistoryCoverage ||
    closeRate + Number.EPSILON < minimumCloseCoverage ||
    !approximatelyEqual(meta.historySuccessRate, historyRate) ||
    !approximatelyEqual(meta.exactCloseCoverage, closeRate)
  ) {
    throw new Error(
      `History coverage must be at least ${(minimumHistoryCoverage * 100).toFixed(0)}% and exact-close coverage at least ${(minimumCloseCoverage * 100).toFixed(0)}%.`
    );
  }
  return { stockCount, historySuccessCount, exactCloseCount, historyRate, closeRate };
}

function approximatelyEqual(value, expected) {
  return Number.isFinite(value) && Math.abs(value - expected) <= 0.000001;
}
