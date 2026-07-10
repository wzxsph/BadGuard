export function shouldPublishDate(entries, date, force) {
  return force || !entries.some((entry) => entry.date === date && entry.status === "ready");
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
