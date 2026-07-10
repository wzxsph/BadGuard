import type { SignalSnapshot, SnapshotMeta } from "./types";

export type SnapshotQualityKind = "bootstrap-seed" | "complete-production" | "partial-or-preview";

export interface SnapshotDataQuality {
  kind: SnapshotQualityKind;
  label: string;
  warning: string;
  stockCount: number | null;
  historySuccessCount: number | null;
  historySuccessRate: number | null;
  exactCloseCount: number | null;
  exactCloseCoverage: number | null;
  universeSource: SnapshotMeta["universeSource"] | "unknown";
  universeSourceLabel: string;
  universeVersion: string | null;
  universeMemberCount: number | null;
  universeStaleCount: number | null;
  universeReuseLabel: string;
  buildMode: SnapshotMeta["buildMode"] | "unknown";
  coverageScope: "full-universe" | "ranked-codes-only" | "unknown";
  dataDate: string;
  refreshedAt: string;
  snapshotTiming: "same-day-close" | "latest-completed" | "unknown";
  snapshotTimingLabel: string;
}

export function getSnapshotDataQuality(
  snapshot: Pick<SignalSnapshot, "meta" | "marketDate" | "refreshedAt">,
  options: { bootstrapSeed?: boolean } = {}
): SnapshotDataQuality {
  const meta = snapshot.meta;
  const stockCount = validCount(meta?.stockCount);
  const bootstrapSeed = options.bootstrapSeed === true || meta?.bootstrapSeed === true;
  const historySuccessCount = firstCount(
    meta?.historySuccessCount,
    stockCount !== null && validCount(meta?.failureCount) !== null
      ? stockCount - validCount(meta.failureCount)!
      : null
  );
  const historySuccessRate = firstRate(
    meta?.historySuccessRate,
    ratio(historySuccessCount, stockCount)
  );
  const seedCloseCount = bootstrapSeed ? validCount(meta?.bootstrapPublishedCloseCount) : null;
  const exactCloseCount = bootstrapSeed
    ? seedCloseCount
    : validCount(meta?.exactCloseCount);
  const exactCloseCoverage = bootstrapSeed
    ? ratio(seedCloseCount, stockCount)
    : firstRate(meta?.exactCloseCoverage, ratio(exactCloseCount, stockCount));
  const universeSource = meta?.universeSource ?? "unknown";
  const acceptedUniverseVersion = validVersion(meta?.universeManifestRevision);
  const universeVersion = acceptedUniverseVersion ??
    validVersion(meta?.universeVersion) ??
    validVersion(meta?.runContextHash);
  const universeMemberCount = validCount(meta?.universeManifestMemberCount);
  const universeStaleCount = validCount(meta?.universeStaleCount);
  const completeProduction = !bootstrapSeed &&
    meta?.buildMode === "production" &&
    meta.universeSource === "code-list" &&
    meta.scanLimit === 0 &&
    meta.perBoardLimit === 0 &&
    acceptedUniverseVersion !== null &&
    historySuccessRate !== null && historySuccessRate >= 0.98 &&
    exactCloseCoverage !== null && exactCloseCoverage >= 0.9;
  const kind: SnapshotQualityKind = bootstrapSeed
    ? "bootstrap-seed"
    : completeProduction
      ? "complete-production"
      : "partial-or-preview";
  const refreshedMarketDate = chinaDate(snapshot.refreshedAt);
  const snapshotTiming = refreshedMarketDate === null
    ? "unknown"
    : refreshedMarketDate > snapshot.marketDate
      ? "latest-completed"
      : refreshedMarketDate === snapshot.marketDate
        ? "same-day-close"
        : "unknown";

  return {
    kind,
    label: kind === "bootstrap-seed"
      ? "临时恢复种子"
      : kind === "complete-production"
        ? "完整生产快照"
        : "非完整生产快照",
    warning: qualityWarning(kind, exactCloseCount, stockCount),
    stockCount,
    historySuccessCount,
    historySuccessRate,
    exactCloseCount,
    exactCloseCoverage,
    universeSource,
    universeSourceLabel: universeSourceLabel(universeSource),
    universeVersion,
    universeMemberCount,
    universeStaleCount,
    universeReuseLabel: universeReuseLabel(universeVersion, universeStaleCount),
    buildMode: meta?.buildMode ?? "unknown",
    coverageScope: bootstrapSeed
      ? "ranked-codes-only"
      : completeProduction
        ? "full-universe"
        : "unknown",
    dataDate: snapshot.marketDate,
    refreshedAt: snapshot.refreshedAt,
    snapshotTiming,
    snapshotTimingLabel: snapshotTiming === "latest-completed"
      ? "沿用最近完整收盘榜单"
      : snapshotTiming === "same-day-close"
        ? "当日完整收盘榜单"
        : "收盘状态未记录"
  };
}

export function withSnapshotDataQuality<T extends { snapshot: SignalSnapshot }>(
  value: T,
  options: { bootstrapSeed?: boolean } = {}
): T & { dataQuality: SnapshotDataQuality } {
  return {
    ...value,
    dataQuality: getSnapshotDataQuality(value.snapshot, options)
  };
}

function qualityWarning(kind: SnapshotQualityKind, closeCount: number | null, stockCount: number | null): string {
  if (kind === "bootstrap-seed") {
    const coverage = closeCount !== null && stockCount !== null ? `当前收盘价仅覆盖 ${closeCount}/${stockCount} 只股票。` : "当前收盘覆盖范围未完整记录。";
    return `这是用于恢复历史 API 的临时种子，价格表只保留榜内代码；${coverage}榜单数量少不能解读为全市场信号很少。`;
  }
  if (kind === "complete-production") {
    return "该快照来自完整固定股票池生产扫描，并通过行情成功率与精确收盘覆盖率校验。";
  }
  return "该快照属于仓库预览、调试、旧版或其他非完整生产数据；榜单数量不能代表完整市场扫描结果。";
}

function universeSourceLabel(source: SnapshotDataQuality["universeSource"]): string {
  if (source === "code-list") return "固定代码池";
  if (source === "realtime") return "实时活跃股票池";
  if (source === "provider") return "外部行情提供方股票池";
  if (source === "bundled") return "随代码附带股票池";
  return "来源未记录";
}

function universeReuseLabel(version: string | null, staleCount: number | null): string {
  if (version === null) return "旧版未记录是否沿用";
  if (staleCount === null) return "固定股票池版本已记录，沿用数量未记录";
  if (staleCount > 0) return `沿用固定池中的 ${staleCount} 只暂时缺席成员`;
  return "固定股票池已核对，本次无暂时缺席成员";
}

function firstCount(...values: unknown[]): number | null {
  for (const value of values) {
    const count = validCount(value);
    if (count !== null) return count;
  }
  return null;
}

function validCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function firstRate(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0 || numerator > denominator) return null;
  return numerator / denominator;
}

function validVersion(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-zA-Z._-]{6,128}$/.test(value) ? value : null;
}

function chinaDate(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
